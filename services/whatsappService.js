import { makeWASocket, DisconnectReason, Browsers, fetchLatestBaileysVersion, delay } from 'baileys';
import { useRedisAuthState, saveDeviceId, removeSession } from '../utils/redisAuthState.js';
import { toDataURL } from 'qrcode';
import { sendWebhook } from '../utils/webhook.js';
import { wrapSocket, readReceiptVariance } from 'baileys-antiban';

const sessions = {};
let cachedBaileysVersion = null;

// Cache the latest Baileys version to avoid redundant external HTTP requests
async function getBaileysVersion() {
	if (!cachedBaileysVersion) {
		try {
			const { version, isLatest } = await fetchLatestBaileysVersion();
			cachedBaileysVersion = version;
		} catch (error) {
			console.error('Gagal mengambil versi Baileys dari internet, menggunakan default [6, 7, 22]:', error);
			cachedBaileysVersion = [6, 7, 22]; // Default fallback version
		}
	}
	return cachedBaileysVersion;
}

async function verifyIsOnWhatsApp(client, jid) {
	// Only verify standard personal numbers
	if (jid.includes('@s.whatsapp.net')) {
		const [result] = await client.onWhatsApp(jid);
		if (!result || !result.exists) {
			throw new Error(`Nomor telepon tidak terdaftar di WhatsApp.`);
		}
	}
}

export async function createWhatsAppClient(deviceId) {
	// Prevent duplicate initialization race conditions
	if (sessions[deviceId] && sessions[deviceId].status === 'initializing') {
		return sessions[deviceId].promise;
	}

	let resolvePromise, rejectPromise;
	const promise = new Promise((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});

	sessions[deviceId] = { status: 'initializing', promise };

	try {
		const { state, saveCreds, removeCreds } = await useRedisAuthState(deviceId);
		const version = await getBaileysVersion();

		let client = makeWASocket({
			version,
			auth: state,
			browser: Browsers.macOS('Desktop'),
			syncFullHistory: false,
			markOnlineOnConnect: true,
			generateHighQualityLinkPreview: false
		});

		client = readReceiptVariance({ meanMs: 1500, stdDevMs: 800 }).wrap(client);
		client = wrapSocket(client, {
			preset: 'moderate',
			warmupDays: 0, // Dimatikan agar tidak melimit 20 pesan per hari (karena nomor mungkin sudah aktif lama)
			logging: true
		});

		sessions[deviceId] = { 
			client, 
			qrCode: null, 
			qrResolver: null, 
			status: 'initialized',
			promise: null 
		};

		client.ev.on('connection.update', async (update) => {
			const { connection, lastDisconnect, qr } = update;

			if (qr) {
				sessions[deviceId].qrCode = await toDataURL(qr);
				if (sessions[deviceId].qrResolver) {
					sessions[deviceId].qrResolver(sessions[deviceId].qrCode);
					sessions[deviceId].qrResolver = null;
				}
			}

			if (connection === 'close') {
				const code = lastDisconnect?.error?.output?.statusCode;
				if (code === DisconnectReason.restartRequired || code === 428) {
					setTimeout(() => createWhatsAppClient(deviceId), 500);
				} else if (code === 401) {
					console.error(`Error 401, Sesi ${deviceId} akan dihapus dan dilogout.`);
					console.error(lastDisconnect?.error?.output);
					await removeCreds();
					await removeSession(deviceId);
					delete sessions[deviceId];
					sendWebhook(deviceId, 'device.disconnected', { reason: 'logged_out', code });
				} else {
					console.error(`Gagal mengkoneksikan device ${deviceId}`);
					console.error(lastDisconnect?.error?.output);
					sendWebhook(deviceId, 'device.disconnected', { reason: 'connection_failed', code });
				}
			}

			if (connection === 'open') {
				sessions[deviceId].qrCode = null;
				await saveDeviceId(deviceId);
				sendWebhook(deviceId, 'device.connected');
			}
		});

		client.ev.on('creds.update', async () => {
			await saveCreds();
		});

		client.ev.on('messages.upsert', async ({ messages, type }) => {
			if (type === 'notify') {
				for (const msg of messages) {
					if (!msg.key.fromMe && msg.message) {
						// Abaikan pesan status/story atau broadcast lainnya
						if (msg.key.remoteJid?.includes('@broadcast')) continue;

						// Cek apakah pesan dari grup
						if (msg.key.remoteJid?.endsWith('@g.us')) {
							const botJid = client.user?.id ? client.user.id.split(':')[0] + '@s.whatsapp.net' : '';
							const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
							const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant || '';
							
							const isMentioned = botJid && mentionedJid.includes(botJid);
							const isQuotingBot = botJid && quotedParticipant === botJid;
							
							// Abaikan pesan grup jika bot tidak di-mention dan pesannya tidak di-reply
							if (!isMentioned && !isQuotingBot) {
								continue;
							}
						}

						// Tandai pesan sudah dibaca
						try {
							await client.readMessages([msg.key]);
						} catch (err) {
							console.error('Gagal mengirim read receipt:', err.message);
						}

						const messageType = Object.keys(msg.message)[0];
						const textContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
						
						sendWebhook(deviceId, 'message.received', {
							from: msg.key.remoteJid,
							participant: msg.key.participant || null,
							pushName: msg.pushName,
							messageType: messageType,
							text: textContent,
							rawMessage: msg
						});
					}
				}
			}
		});

		resolvePromise(client);
		return client;
	} catch (error) {
		console.error(`Gagal membuat WhatsApp client untuk ${deviceId}:`, error);
		delete sessions[deviceId];
		rejectPromise(error);
		throw error;
	}
}

export function checkConnectionStatus(deviceId) {
	return getConnectionStatus(deviceId).connected;
}

export async function generateQRCode(deviceId) {
	if (sessions[deviceId]?.client?.user) return 'connected';

	if (!sessions[deviceId]) {
		await createWhatsAppClient(deviceId);
	}

	if (sessions[deviceId]?.qrCode) {
		return sessions[deviceId].qrCode;
	}

	return new Promise((resolve) => {
		sessions[deviceId].qrResolver = resolve;
	});
}

export async function send_wa(deviceId, phoneNumber, message, quotedMessage = null) {
	const formatted = phoneNumber.includes('@s.whatsapp.net') || phoneNumber.includes('@g.us') || phoneNumber.includes('@lid') 
		? phoneNumber 
		: `${phoneNumber}@s.whatsapp.net`;

	let session = sessions[deviceId];
	if (!session) {
		await createWhatsAppClient(deviceId);
		session = sessions[deviceId];
	}

	const client = session?.client;
	if (!client) throw new Error(`Client untuk ${deviceId} tidak ditemukan.`);

	// Wait up to 5 seconds if connection is currently being established
	if (!client.user) {
		let retries = 0;
		while (!client.user && retries < 10) {
			await delay(500);
			retries++;
		}
		if (!client.user) {
			throw new Error(`Device ${deviceId} tidak aktif atau belum terhubung. Silakan pindai QR code terlebih dahulu.`);
		}
	}

	try {
		await verifyIsOnWhatsApp(client, formatted);

		await client.presenceSubscribe(formatted);
		await delay(500);

		await client.sendPresenceUpdate('composing', formatted);
		const typingTime = Math.min((message?.length || 10) * 50, 6000);
		await delay(typingTime);

		await client.sendPresenceUpdate('paused', formatted);
		
		const sendOptions = { text: message };
		const extraOptions = quotedMessage ? { quoted: quotedMessage } : {};
		await client.sendMessage(formatted, sendOptions, extraOptions);
	} catch (error) {
		if (error.output?.statusCode === 401 || error.output?.statusCode === 428) {
			await createWhatsAppClient(deviceId);
		}
		throw error;
	}
}

export async function sendImage(deviceId, phoneNumber, imageBuffer, caption = '') {
	const formatted = phoneNumber.includes('@s.whatsapp.net') || phoneNumber.includes('@g.us') || phoneNumber.includes('@lid') 
		? phoneNumber 
		: `${phoneNumber}@s.whatsapp.net`;

	let session = sessions[deviceId];
	if (!session) {
		await createWhatsAppClient(deviceId);
		session = sessions[deviceId];
	}

	const client = session?.client;
	if (!client) throw new Error(`Client untuk ${deviceId} tidak ditemukan.`);

	if (!client.user) {
		let retries = 0;
		while (!client.user && retries < 10) {
			await delay(500);
			retries++;
		}
		if (!client.user) {
			throw new Error(`Device ${deviceId} tidak aktif atau belum terhubung. Silakan pindai QR code terlebih dahulu.`);
		}
	}

	await verifyIsOnWhatsApp(client, formatted);

	await client.sendMessage(formatted, {
		image: imageBuffer,
		caption,
		mimetype: 'image/jpeg',
	});
}

export async function sendDocumentFromUrl(deviceId, phoneNumber, fileUrl, fileName, caption = '', mimetype = '') {
	const formatted = phoneNumber.includes('@s.whatsapp.net') || phoneNumber.includes('@g.us') || phoneNumber.includes('@lid') 
		? phoneNumber 
		: `${phoneNumber}@s.whatsapp.net`;

	let session = sessions[deviceId];
	if (!session) {
		await createWhatsAppClient(deviceId);
		session = sessions[deviceId];
	}

	const client = session?.client;
	if (!client) throw new Error(`Client untuk ${deviceId} tidak ditemukan.`);
	
	if (!client.user) {
		let retries = 0;
		while (!client.user && retries < 10) {
			await delay(500);
			retries++;
		}
		if (!client.user) {
			throw new Error(`Device ${deviceId} tidak aktif atau belum terhubung. Silakan pindai QR code terlebih dahulu.`);
		}
	}

	await verifyIsOnWhatsApp(client, formatted);

	await client.presenceSubscribe(formatted);
	await delay(500);

	await client.sendPresenceUpdate('composing', formatted);
	await delay(2000);

	await client.sendPresenceUpdate('paused', formatted);

	await client.sendMessage(formatted, {
		document: { url: fileUrl }, 
		fileName: fileName,
		caption: caption,
		mimetype: mimetype || 'application/octet-stream',
	});
}

export async function getMyProfilePicture(deviceId, retries = 3) {
	let session = sessions[deviceId];
	if (!session) {
		await createWhatsAppClient(deviceId);
		session = sessions[deviceId];
	}

	const client = session?.client;
	if (!client) throw new Error('Client belum terhubung.');

	if (!client.user) {
		let checkRetries = 0;
		while (!client.user && checkRetries < 10) {
			await delay(500);
			checkRetries++;
		}
		if (!client.user) throw new Error('Client belum terhubung.');
	}

	try {
		return await Promise.race([
			client.profilePictureUrl(client.user.id, 'image'),
			new Promise((_, reject) => setTimeout(() => reject(new Error('Timed Out')), 10000)),
		]);
	} catch (error) {
		if (retries > 0) {
			return getMyProfilePicture(deviceId, retries - 1);
		}
		throw error;
	}
}

export function getConnectionStatus(deviceId) {
	const session = sessions[deviceId];

	if (!session) return { status: 'not_initialized', connected: false };
	if (!session.client) return { status: 'not_initialized', connected: false };
	if (!session.client.user) {
		return session.qrCode
			? { status: 'connecting', connected: false }
			: { status: 'waiting_qr', connected: false };
	}

	return { status: 'connected', connected: true };
}

export async function logoutDevice(deviceId) {
	const session = sessions[deviceId];
	if (!session || !session.client) {
		throw new Error(`Device ${deviceId} tidak ditemukan.`);
	}

	const client = session.client;
	await client.logout();
	client.ws.close();
	await removeSession(deviceId);
	delete sessions[deviceId];
}
