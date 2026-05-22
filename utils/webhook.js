import axios from 'axios';
import 'dotenv/config';

/**
 * Mengirimkan data event ke WEBHOOK_URL yang dikonfigurasi di .env
 * @param {string} deviceId ID perangkat yang memicu event
 * @param {string} eventName Nama event (contoh: 'message.received', 'device.connected')
 * @param {object} payload Data tambahan yang dikirimkan bersama event
 */
export async function sendWebhook(deviceId, eventName, payload = {}) {
    const webhookUrl = process.env.WEBHOOK_URL;
    
    // Jangan lakukan apapun jika webhook belum diatur
    if (!webhookUrl || webhookUrl.trim() === '') {
        return;
    }

    const data = {
        deviceId,
        event: eventName,
        timestamp: new Date().toISOString(),
        data: payload
    };

    try {
        await axios.post(webhookUrl, data, {
            timeout: 5000 // Timeout 5 detik agar tidak memblokir aplikasi
        });
        // console.log(`Webhook sent for event: ${eventName} from device: ${deviceId}`);
    } catch (error) {
        console.error(`Gagal mengirim webhook (${eventName}) untuk device ${deviceId}:`, error.message);
    }
}
