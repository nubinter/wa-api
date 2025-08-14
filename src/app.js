const express = require('express');
const axios = require('axios');
const multer = require('multer');
const { createWhatsAppClient, checkConnectionStatus, generateQRCode, send_wa, sendImage, getMyProfilePicture, logoutDevice } = require('./services/whatsappService');
const { getAllDeviceIds } = require('./utils/dbAuthState');
require('dotenv').config(); // Load environment variables from .env file
const app = express();
const port = process.env.PORT || 3000;
const upload = multer();
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Lakukan sesuatu dengan error, seperti mengirim notifikasi atau log ke file
});

app.use(express.json());

// Endpoint untuk mengambil QR Code
app.get('/get-qr', async (req, res) => {
  const { deviceId } = req.query; // Ambil deviceId dari query parameter

  if (!deviceId) {
    return res.status(400).json({ success: false, pesan: 'deviceId is required' });
  }

  try {
    const qr = await generateQRCode(deviceId); // Kirim deviceId ke generateQRCode
    if(qr == 'connected') {
      res.status(200).json({ success: false, status: 'connected', qrCode: null, pesan: 'Device sudah terhubung' });
    } else {
      res.status(200).json({ success: true, status: 'connecting', qrCode: qr, pesan: 'Silahkan pindai qr code untuk menghubungkan.' });
    }
  } catch (error) {
    res.status(500).json({ success: false, status: 'error', qrCode: null, pesan: error.message });
  }
});

// Endpoint untuk mengirim pesan
app.post('/send-message', upload.none(), async (req, res) => {
  const { deviceId, phoneNumber, message } = req.body; // Ambil deviceId dari body

  if (!deviceId || !phoneNumber || !message) {
    return res.status(400).json({ success: false, pesan: 'deviceId, phoneNumber, and message are required' });
  }

  try {
    await send_wa(deviceId, phoneNumber, message); // Panggil fungsi send_wa dengan parameter
    res.status(200).json({ success: true, pesan: 'Pesan berhasil dikirim' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ success: false, pesan: error.message });
  }
});

app.post('/send-image', upload.none(), async (req, res) => {
  const { deviceId, phoneNumber, imageUrl, caption } = req.body;

  if (!deviceId || !phoneNumber || !imageUrl) {
    return res.status(400).json({ success: false, pesan: 'deviceId, phoneNumber, dan imageUrl diperlukan.' });
  }

  try {
    // Unduh gambar dari URL
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(response.data, 'binary'); // Konversi ke Buffer

    await sendImage(deviceId, phoneNumber, imageBuffer, caption);
    res.status(200).json({ success: true, pesan: 'Gambar berhasil dikirim.' });
  } catch (error) {
    console.error('Gagal mengirim gambar:', error);
    res.status(500).json({ success: false, pesan: error.message });
  }
});


// Endpoint untuk mengecek status koneksi
app.get('/check-connection', async (req, res) => {
  const { deviceId } = req.query; // Ambil deviceId dari query parameter

  if (!deviceId) {
    return res.status(400).json({ success: false, pesan: 'deviceId is required' });
  }

  try {
    const isConnected = checkConnectionStatus();
    res.status(200).json({ success: true, status: isConnected, pesan: 'Device terhubung' });
  } catch (error) {
    res.status(500).json({ success: false, status: false, pesan: error.message });
  }
});

// Endpoint untuk mengambil foto profil akun sendiri
app.get('/my-profile-picture', async (req, res) => {
  const { deviceId } = req.query; // Ambil deviceId dari query parameter

  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId is required' });
  }

  try {
    const profilePictureUrl = await getMyProfilePicture(deviceId);
    res.status(200).json({ success: true, picture_url: profilePictureUrl });
  } catch (error) {
    res.status(500).json({ success: false, pesan: error.message });
  }
});

app.post('/logout', upload.none(), async (req, res) => {
  const { deviceId } = req.body;

  if (!deviceId) {
    return res.status(400).json({ success: false, message: 'deviceId is required' });
  }

  try {
    await logoutDevice(deviceId);
    res.status(200).json({ success: true, pesan: `Device ${deviceId} berhasil logout.` });
  } catch (error) {
    res.status(500).json({ success: false, pesan: error.message });
  }
});

const initializeSessions = async () => {
  console.log("Memuat semua sesi WhatsApp yang tersimpan...");
  const deviceIds = await getAllDeviceIds();

  for (const deviceId of deviceIds) {
    console.log(`Menghubungkan ulang ${deviceId}...`);
    await createWhatsAppClient(deviceId);
  }
};

initializeSessions();

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});