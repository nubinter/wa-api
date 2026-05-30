import { App } from '@tinyhttp/app';
import { json } from 'milliparsec';
import dotenv from 'dotenv';
import axios from 'axios';
import {
  createWhatsAppClient,
  getConnectionStatus,
  generateQRCode,
  send_wa,
  sendDocumentFromUrl,
  sendImage,
  getMyProfilePicture,
  getGroups,
  logoutDevice
} from './services/whatsappService.js';
import { getAllDeviceIds } from './utils/redisAuthState.js';

dotenv.config();

const app = new App();
const port = parseInt(process.env.PORT || '3000');

app.use(json({ payloadLimit: 50 * 1024 * 1024 })); // 50MB limit

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
  const { deviceId, phoneNumber, message, quotedMessage } = req.body;
  if (!deviceId || !phoneNumber || !message) {
    return res.status(400).json({ success: false, pesan: 'deviceId, phoneNumber, and message are required' });
  }

  try {
    await send_wa(deviceId, phoneNumber, message, quotedMessage);
    res.status(200).json({ success: true, pesan: 'Pesan berhasil dikirim' });
  } catch (error) {
    res.status(500).json({ success: false, pesan: error.message });
  }
});

/**
 * Endpoint POST untuk mengirim dokumen dari URL.
 * Route: /send-document-url
 */
app.post('/send-document-url', async (req, res) => {
	
	// Mendestrukturisasi data yang dibutuhkan dari body request
	// tinyhttp akan menyediakan req.body setelah middleware json() dipanggil
	const { 
		deviceId, 
		phoneNumber, 
		fileUrl,      
		fileName,     
		caption = '', 
		mimetype = '' 
	} = req.body;

	// Validasi input wajib
	if (!deviceId || !phoneNumber || !fileUrl || !fileName) {
		return res.status(400).json({ 
			success: false, 
			pesan: 'deviceId, phoneNumber, fileUrl, and fileName are required' 
		});
	}

	try {
		// Panggil fungsi Baileys Anda
		await sendDocumentFromUrl(deviceId, phoneNumber, fileUrl, fileName, caption, mimetype);
		
		// Menggunakan res.json() untuk mengirim respons JSON
		res.status(200).json({ 
			success: true, 
			pesan: `Dokumen "${fileName}" berhasil dikirim ke ${phoneNumber}` 
		});
	} catch (error) {
		console.error('Error saat mengirim dokumen:', error);
		res.status(500).json({ 
			success: false, 
			pesan: `Gagal mengirim dokumen: ${error.message}` 
		});
	}
});

app.post('/send-image', async (req, res) => {
  const { deviceId, phoneNumber, imageUrl, caption } = req.body;
  if (!deviceId || !phoneNumber || !imageUrl) {
    return res.status(400).json({ success: false, pesan: 'deviceId, phoneNumber, dan imageUrl diperlukan.' });
  }

  // SSRF Protection: Validate URL and block private IP ranges / localhost
  try {
    const parsedUrl = new URL(imageUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return res.status(400).json({ success: false, pesan: 'Protokol URL tidak valid. Hanya HTTP dan HTTPS yang diizinkan.' });
    }
    const hostname = parsedUrl.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('172.16.') ||
      hostname.startsWith('169.254.')
    ) {
      return res.status(400).json({ success: false, pesan: 'Akses ke alamat IP lokal/internal tidak diizinkan.' });
    }
  } catch (err) {
    return res.status(400).json({ success: false, pesan: 'Format URL gambar tidak valid.' });
  }

  try {
    // Fetch image safely: 10s timeout, max 10MB file size
    const response = await axios.get(imageUrl, { 
      responseType: 'arraybuffer',
      timeout: 10000, 
      maxContentLength: 10 * 1024 * 1024 
    });
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

app.get('/groups', async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

  try {
    const groups = await getGroups(deviceId);
    res.status(200).json({ success: true, groups });
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
  const deviceIds = await getAllDeviceIds();
  for (const deviceId of deviceIds) {
    await createWhatsAppClient(deviceId);
  }
};

initializeSessions().catch(err => {
  console.error('Gagal menginisialisasi sesi WhatsApp pada startup:', err);
});

app.listen(port, () => {
});
