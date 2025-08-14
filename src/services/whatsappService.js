const { makeWASocket, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { useMySQLAuthState, saveDeviceId, removeSession } = require('../utils/dbAuthState');
const qrcode = require('qrcode-terminal');
const { toDataURL } = require('qrcode');
const sessions = {}; // Menyimpan semua sesi aktif

const createWhatsAppClient = async (deviceId) => {
	console.log(`Memulai koneksi untuk ${deviceId}`);

	const { state, saveCreds, removeCreds } = await useMySQLAuthState(deviceId);

	const client = makeWASocket({
		auth: state,
		printQRInTerminal: true,
		shouldSyncHistoryMessage: false,
		browser: Browsers.macOS("Desktop"),
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
			console.log(`WhatsApp ${deviceId} terputus.`);
			const shouldReconnect = lastDisconnect?.error?.output?.statusCode === DisconnectReason.restartRequired;
			if (shouldReconnect) {
				setTimeout(async () => {
					await createWhatsAppClient(deviceId);
				}, 5000);
			} else if (lastDisconnect?.error?.output?.statusCode === 401) {
				console.log('Connection closed. Logged out.');
				await removeCreds(); // Implementasikan fungsi ini di `dbAuthState.js`
				delete sessions[deviceId];
				await logoutDevice(deviceId);
			} else if (lastDisconnect?.error?.output?.statusCode === 428) {
				console.log('Connection closed. Restart Connection.');
				setTimeout(async () => {
					await createWhatsAppClient(deviceId);
				}, 5000);
			} else if (lastDisconnect?.error?.output?.statusCode === 428) {
				console.log('Connection closed. Restart Connection.');
				setTimeout(async () => {
					await createWhatsAppClient(deviceId);
				}, 5000);
			}
		}

		if (connection === 'open') {
			console.log(`WhatsApp ${deviceId} berhasil terhubung.`);
			sessions[deviceId].qrCode = null;
			await saveDeviceId(deviceId); // Simpan deviceId ke database
		}
	});

	client.ev.on('creds.update', async () => {
		console.log('Kredensial diperbarui');
		await saveCreds();
	});

	return client;
};

const checkConnectionStatus = (deviceId) => {
	return sessions[deviceId]?.client?.user !== null;
};

const generateQRCode = async (deviceId) => {
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
};

const send_wa = async (deviceId, phoneNumber, message) => {
	const formattedPhoneNumber = phoneNumber.includes('@s.whatsapp.net') ? phoneNumber : `${phoneNumber}@s.whatsapp.net`;

	if (!sessions[deviceId]) {
		console.log(`Device ${deviceId} belum diinisiasi, mencoba menghubungkan...`);
		await createWhatsAppClient(deviceId);
	}

	const client = sessions[deviceId]?.client;
	if (!client) throw new Error(`Client untuk ${deviceId} tidak ditemukan.`);

	if (!client.user) {
		console.log(`Menunggu koneksi untuk ${deviceId}...`);
		await createWhatsAppClient(deviceId);
		await new Promise((resolve, reject) => {
			client.ev.on('connection.update', (update) => {
				if (update.connection === 'open') resolve();
				if (update.connection === 'close') reject(new Error('Connection closed unexpectedly'));
				if (update.qr) {
					reject(new Error('Connection reset. Scan ulang QR code'));
				}
			});
		});
	}

	try {
		console.log(`Mengirim pesan ke ${formattedPhoneNumber}: ${message} menggunakan device ${deviceId}`);
		await client.sendMessage(formattedPhoneNumber, { text: message });
	} catch (error) {
		console.log('Gagal mengirim pesan:', error);
		if (error.output.statusCode === 401 || error.output.statusCode === 428) {
			console.log('Connection closed. Reconnecting...');
			await createWhatsAppClient(deviceId);
		}
		throw error;
	}
};

const sendImage = async (deviceId, phoneNumber, imageBuffer, caption = '') => {
	const formattedPhoneNumber = phoneNumber.includes('@s.whatsapp.net') ? phoneNumber : `${phoneNumber}@s.whatsapp.net`;

	if (!sessions[deviceId]) {
		console.log(`Device ${deviceId} belum diinisiasi, mencoba menghubungkan...`);
		await createWhatsAppClient(deviceId);
	}

	const client = sessions[deviceId]?.client;
	if (!client) throw new Error(`Client untuk ${deviceId} tidak ditemukan.`);

	try {
		console.log(`Mengirim gambar ke ${formattedPhoneNumber} dari URL dengan caption: ${caption}`);

		await client.sendMessage(formattedPhoneNumber, {
			image: imageBuffer,
			caption: caption,
			mimetype: 'image/jpeg', // Sesuaikan jika format lain
		});

		console.log('Gambar berhasil dikirim.');
	} catch (error) {
		console.error('Gagal mengirim gambar:', error);
		throw error;
	}
};

const getMyProfilePicture = async (deviceId, retries = 3) => {
	console.log(`Mengambil foto profil untuk ${deviceId}...`);
	if (!sessions[deviceId]?.client) {
		console.log('Client belum diinisiasi, mencoba menghubungkan...');
		await createWhatsAppClient(deviceId);
	}

	const client = sessions[deviceId]?.client;
	if (!client || !client.user) throw new Error('Client belum terhubung ke WhatsApp.');

	try {
		return await Promise.race([
			client.profilePictureUrl(client.user.id, 'image'),
			new Promise((_, reject) => setTimeout(() => reject(new Error('Timed Out')), 10000)),
		]);
	} catch (error) {
		if (retries > 0) {
			console.log(`Mencoba ulang... (${retries} percobaan tersisa)`);
			return getMyProfilePicture(retries - 1, deviceId);
		}
		console.error('Gagal mengambil foto profil:', error);
		throw error;
	}
};

const logoutDevice = async (deviceId) => {
	await new Promise((resolve, reject) => {
		if (!sessions[deviceId]) {
			console.log(`Device ${deviceId} tidak ditemukan dalam sesi aktif.`);
			reject(new Error(`Device ${deviceId} tidak ditemukan dalam sesi aktif.`));
		} else {
			resolve();
		}
	})
	try {
		const client = sessions[deviceId].client;
		console.log(`Melakukan logout untuk ${deviceId}...`);

		await client.logout(); // Logout dari WhatsApp
		client.ws.close(); // Tutup koneksi WebSocket

		// Hapus session dari database
		await removeSession(deviceId);

		// Hapus session dari memori aplikasi
		delete sessions[deviceId];

		console.log(`Device ${deviceId} berhasil logout dan sesi dihapus.`);
		return;
	} catch (error) {
		console.error(`Gagal logout untuk ${deviceId}:`, error);
		throw error;
	}
};


module.exports = { createWhatsAppClient, checkConnectionStatus, generateQRCode, send_wa, sendImage, getMyProfilePicture, logoutDevice };
