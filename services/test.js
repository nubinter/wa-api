const { makeWASocket, makeCacheableSignalKeyStore, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { useMySQLAuthState } = require('../utils/dbAuthState');
const qrcode = require('qrcode-terminal');
const { toDataURL } = require('qrcode');
const sessions = {}; // Menyimpan semua sesi aktif

let client = null;
let qrCode = null; // Variabel untuk menyimpan QR Code
let qrResolver = null; // Variabel untuk menyimpan resolver dari Promise

const createWhatsAppClient = async (deviceId) => {
    /*if (sessions[deviceId]) {
        console.log(`WhatsApp ${deviceId} sudah berjalan.`);
        return sessions[deviceId];
    }*/

    console.log(`Memulai koneksi untuk ${deviceId}`);

    // Baca auth state dari database
    const { state, saveCreds } = await useMySQLAuthState(deviceId);

    // Buat socket WhatsApp
    client = makeWASocket({
        auth: state,
        printQRInTerminal: true, // Tampilkan QR Code di terminal
        shouldSyncHistoryMessage: false,
        browser: Browsers.macOS("Desktop"),
    });

    // Simpan sesi ke dalam objek sessions
    sessions[deviceId] = { client, qrCode: null, qrResolver: null };

    // Event untuk menghasilkan QR Code
    client.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update
        if (qr) {
            sessions[deviceId].qrCode = toDataURL(qr); // Simpan QR Code ke variabel
            // Jika ada resolver, resolve Promise dengan QR Code
            if (sessions[deviceId].qrResolver) {
                sessions[deviceId].qrResolver(sessions[deviceId].qrCode);
                sessions[deviceId].qrResolver = null; // Reset resolver
            }
        }
        if (connection === 'close') {
            console.log(`WhatsApp ${deviceId} terputus.`);
            //delete sessions[deviceId]; // Hapus sesi dari memori

            const shouldReconnect = lastDisconnect?.error?.output?.statusCode === DisconnectReason.restartRequired;
            console.log('shouldReconnect', shouldReconnect);

            if (shouldReconnect) {
                console.log('Connected to WhatsApp');
                qrCode = null; // Hapus QR Code setelah terhubung
                // create a new socket, this socket is now useless
                createWhatsAppClient(deviceId); // Buat koneksi baru dengan deviceId yang sama
            } else {
                console.log('Last disconnect', lastDisconnect);
                console.log('DisconnectReason', DisconnectReason);
                if (lastDisconnect?.error?.output?.statusCode == 401) {
                    console.log('Connection closed. Logged out.')
                    removeCreds(deviceId);
                    delete sessions[deviceId];
                } else {
                    console.log('Connection closed', lastDisconnect?.error?.output?.statusCode);
                }
            }
        }
        if (connection === 'open') {
            console.log(`WhatsApp ${deviceId} berhasil terhubung.`);
            sessions[deviceId].qrCode = null;
        }
        if (connection === 'error') {
            console.error('Connection error:', lastDisconnect?.error);
            removeCreds();
        }
    });

    // Event untuk menyimpan auth state ke database
    client.ev.on('creds.update', async (creds) => {
        console.log('credential updated');
        saveCreds() // Simpan kredensial dengan deviceId
    });

    return client;

};


// Fungsi untuk mengecek status koneksi
const checkConnectionStatus = (deviceId) => {
    return sessions[deviceId]?.client?.user !== null;
};

// Fungsi untuk memaksa menghasilkan QR Code
const generateQRCode = async (deviceId) => {
    delete sessions[deviceId];
    await createWhatsAppClient(deviceId);

    // Jika koneksi sudah terbuka, langsung kembalikan pesan
    if (sessions[deviceId]?.client?.user) {
        return 'connected';
    }

    if (sessions[deviceId]?.qrCode) {
        return sessions[deviceId].qrCode;
    }

    // Buat Promise untuk menunggu QR Code terisi
    return new Promise((resolve) => {
        sessions[deviceId].qrResolver = resolve;
    });
};


const send_wa = async (deviceId, phoneNumber, message) => {
    // Pastikan nomor telepon memiliki format yang benar
    const formattedPhoneNumber = phoneNumber.includes('@s.whatsapp.net') ? phoneNumber : `${phoneNumber}@s.whatsapp.net`;
    if (!sessions[deviceId]) {
        console.log(`Device ${deviceId} belum diinisiasi, mencoba menghubungkan...`);
        await createWhatsAppClient(deviceId);

        const client = sessions[deviceId]?.client;

        client.ev.on('connection.update', (update) => {
            const { connection } = update
            if (connection === 'open') {
                console.log(`Mengirim pesan ke ${formattedPhoneNumber}: ${message} menggunakan device ${deviceId}`);
                client.sendMessage(formattedPhoneNumber, { text: message });
            }
        });
    } else {
        const client = sessions[deviceId]?.client;
        try {
            console.log(`Mengirim pesan ke ${formattedPhoneNumber}: ${message} menggunakan device ${deviceId}`);
            await client.sendMessage(formattedPhoneNumber, { text: message });
        } catch (error) {
            console.log('Gagal mengirim pesan:', error);
            await createWhatsAppClient(deviceId);
            client.ev.on('connection.update', (update) => {
                const { connection } = update
                if (connection === 'open') {
                    console.log(`Mengirim ulang pesan ke ${formattedPhoneNumber}: ${message} menggunakan device ${deviceId}`);
                    client.sendMessage(formattedPhoneNumber, { text: message });
                }
            });
            throw error; // Lempar error agar bisa ditangkap di route
        }
    }
}

// Fungsi untuk mengambil foto profil akun sendiri
const getMyProfilePicture = async (retries = 3, deviceId) => {
    if (!client) {
        console.log('belum inisiasi');
        await createWhatsAppClient(deviceId);
    }

    if (!client.user) {
        throw new Error('Client belum terhubung ke WhatsApp.');
    }

    try {
        // Tambahkan timeout manual jika diperlukan
        const profilePictureUrl = await Promise.race([
            client.profilePictureUrl(client.user.id, 'image'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timed Out')), 10000)), // Timeout 10 detik
        ]);
        return profilePictureUrl;
    } catch (error) {
        if (retries > 0) {
            console.log(`Mencoba ulang... (${retries} percobaan tersisa)`);
            return getMyProfilePicture(retries - 1); // Coba ulang
        }
        console.error('Gagal mengambil foto profil setelah beberapa percobaan:', error);
        throw error;
    }
};

// Fungsi untuk membuat delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { createWhatsAppClient, checkConnectionStatus, generateQRCode, send_wa, getMyProfilePicture };