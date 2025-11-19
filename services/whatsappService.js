import { makeWASocket, DisconnectReason, Browsers, fetchLatestBaileysVersion } from 'baileys';
import { useMySQLAuthState, saveDeviceId, removeSession } from '../utils/dbAuthState.js';
import { toDataURL } from 'qrcode';

const sessions = {};

export async function createWhatsAppClient(deviceId) {
	const { state, saveCreds, removeCreds } = await useMySQLAuthState(deviceId);

	const { version, isLatest } = await fetchLatestBaileysVersion();
	console.log(`Using Baileys version: ${version.join('.')}, isLatest: ${isLatest}`);

	const client = makeWASocket({
		version,
		auth: state,
		browser: Browsers.macOS('Desktop'),
	});

	sessions[deviceId] = { client, qrCode: null, qrResolver: null };

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
				console.log('Koneksi terhubung, perlu dilakukan restart.')
				setTimeout(() => createWhatsAppClient(deviceId), 500);
			} else if (code === 401) {
				console.log('Error 401, Session akan dihapus dan dilogout')
				console.log(lastDisconnect?.error?.output)
				await removeCreds();
				await removeSession(deviceId);
				delete sessions[deviceId];
			} else {
				console.log('Gagal mengkoneksikan device '+deviceId)
				console.log(lastDisconnect?.error?.output)
			}
		}

		if (connection === 'open') {
			sessions[deviceId].qrCode = null;
			await saveDeviceId(deviceId);
		}
	});

	client.ev.on('creds.update', async () => {
		await saveCreds();
	});

	return client;
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

export async function send_wa(deviceId, phoneNumber, message) {
	const formatted = phoneNumber.includes('@s.whatsapp.net') ? phoneNumber : `${phoneNumber}@s.whatsapp.net`;

	if (!sessions[deviceId]) {
		await createWhatsAppClient(deviceId);
	}

	const client = sessions[deviceId]?.client;
	if (!client) throw new Error(`Client untuk ${deviceId} tidak ditemukan.`);

	if (!client.user) {
		await createWhatsAppClient(deviceId);
		await new Promise((resolve, reject) => {
			client.ev.on('connection.update', (update) => {
				if (update.connection === 'open') resolve();
				if (update.connection === 'close') reject(new Error('Connection closed'));
				if (update.qr) reject(new Error('QR code expired'));
			});
		});
	}

	try {
		await client.sendMessage(formatted, { text: message });
	} catch (error) {
		if (error.output?.statusCode === 401 || error.output?.statusCode === 428) {
			await createWhatsAppClient(deviceId);
		}
		throw error;
	}
}

export async function sendImage(deviceId, phoneNumber, imageBuffer, caption = '') {
	const formatted = phoneNumber.includes('@s.whatsapp.net') ? phoneNumber : `${phoneNumber}@s.whatsapp.net`;

	if (!sessions[deviceId]) {
		await createWhatsAppClient(deviceId);
	}

	const client = sessions[deviceId]?.client;
	if (!client) throw new Error(`Client untuk ${deviceId} tidak ditemukan.`);

	await client.sendMessage(formatted, {
		image: imageBuffer,
		caption,
		mimetype: 'image/jpeg',
	});
}

export async function getMyProfilePicture(deviceId, retries = 3) {
	if (!sessions[deviceId]?.client) {
		await createWhatsAppClient(deviceId);
	}

	const client = sessions[deviceId]?.client;
	if (!client || !client.user) throw new Error('Client belum terhubung.');

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
	if (!sessions[deviceId]) {
		throw new Error(`Device ${deviceId} tidak ditemukan.`);
	}

	const client = sessions[deviceId].client;
	await client.logout();
	client.ws.close();
	await removeSession(deviceId);
	delete sessions[deviceId];
}
