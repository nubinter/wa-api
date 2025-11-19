import { App } from '@tinyhttp/app';
import { json } from 'milliparsec';
import dotenv from 'dotenv';
import axios from 'axios';
import {
  createWhatsAppClient,
  getConnectionStatus,
  generateQRCode,
  send_wa,
  sendImage,
  getMyProfilePicture,
  logoutDevice
} from './services/whatsappService.js';
import { getAllDeviceIds } from './utils/dbAuthState.js';

dotenv.config();

const app = new App();
const port = parseInt(process.env.PORT || '3000');

app.use(json());

/*app.get('/get-qr', async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ success: false, pesan: 'deviceId is required' });

  try {
    const qr = await generateQRCode(deviceId);
    if (qr === 'connected') {
      res.status(200).json({ success: false, status: 'connected', qrCode: null, pesan: 'Device sudah terhubung' });
    } else {
      res.status(200).json({ success: true, status: 'connecting', qrCode: qr, pesan: 'Silahkan pindai qr code untuk menghubungkan.' });
    }
  } catch (error) {
    res.status(500).json({ success: false, status: 'error', qrCode: null, pesan: error.message });
  }
});*/

app.get('/get-qr', async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ success: false, pesan: 'deviceId is required' });

  try {
    const { status, connected } = getConnectionStatus(deviceId);

    if (connected) {
      return res.status(200).json({ success: false, status, qrCode: null, pesan: 'Device sudah terhubung' });
    }

    const qr = await generateQRCode(deviceId);
    res.status(200).json({ success: true, status, qrCode: qr, pesan: 'Silahkan pindai qr code untuk menghubungkan.' });
  } catch (error) {
    res.status(500).json({ success: false, status: 'error', qrCode: null, pesan: error.message });
  }
});


app.post('/send-message', async (req, res) => {
  console.log(req.body)
  const { deviceId, phoneNumber, message } = req.body;
  if (!deviceId || !phoneNumber || !message) {
    return res.status(400).json({ success: false, pesan: 'deviceId, phoneNumber, and message are required' });
  }

  try {
    await send_wa(deviceId, phoneNumber, message);
    res.status(200).json({ success: true, pesan: 'Pesan berhasil dikirim' });
  } catch (error) {
    res.status(500).json({ success: false, pesan: error.message });
  }
});

app.post('/send-image', async (req, res) => {
  const { deviceId, phoneNumber, imageUrl, caption } = req.body;
  if (!deviceId || !phoneNumber || !imageUrl) {
    return res.status(400).json({ success: false, pesan: 'deviceId, phoneNumber, dan imageUrl diperlukan.' });
  }

  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(response.data, 'binary');
    await sendImage(deviceId, phoneNumber, imageBuffer, caption);
    res.status(200).json({ success: true, pesan: 'Gambar berhasil dikirim.' });
  } catch (error) {
    res.status(500).json({ success: false, pesan: error.message });
  }
});

app.get('/check-connection', async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ success: false, pesan: 'deviceId is required' });

  try {
    const { status, connected } = getConnectionStatus(deviceId);
    res.status(200).json({ success: true, status, connected, pesan: `Status: ${status}` });
  } catch (error) {
    res.status(500).json({ success: false, status: 'error', connected: false, pesan: error.message });
  }
});

app.get('/my-profile-picture', async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

  try {
    const profilePictureUrl = await getMyProfilePicture(deviceId);
    res.status(200).json({ success: true, picture_url: profilePictureUrl });
  } catch (error) {
    res.status(500).json({ success: false, pesan: error.message });
  }
});

app.post('/logout', async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ success: false, message: 'deviceId is required' });

  try {
    await logoutDevice(deviceId);
    res.status(200).json({ success: true, pesan: `Device ${deviceId} berhasil logout.` });
  } catch (error) {
    res.status(500).json({ success: false, pesan: error.message });
  }
});


const initializeSessions = async () => {
  console.log('Memuat semua sesi WhatsApp yang tersimpan...');
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
