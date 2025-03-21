const mysql = require('mysql2/promise');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

// Konfigurasi koneksi database
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'whatsapp_api',
};

// Helper untuk mendapatkan koneksi database
const getConnection = async () => {
    return await mysql.createConnection(dbConfig);
};

// Fungsi untuk membaca data dari database
const readData = async (deviceId, id) => {
    const connection = await getConnection();
    const [rows] = await connection.execute('SELECT data FROM whatsapp_auth_state WHERE deviceId = ? AND id = ?', [deviceId, id]);
    await connection.end();
    return rows.length > 0 ? JSON.parse(rows[0].data, BufferJSON.reviver) : null;
};

// Fungsi untuk menyimpan data ke database
const writeData = async (deviceId, id, data) => {
    if (!data) return;
    const connection = await getConnection();

    // Periksa apakah data sudah ada untuk deviceId dan id tertentu
    const [rows] = await connection.execute(
        `SELECT 1 FROM whatsapp_auth_state WHERE id = ? AND deviceId = ? LIMIT 1`,
        [id, deviceId]
    );

    if (rows.length > 0) {
        console.log('Data ditemukan, lakukan update data', id, deviceId);
        // Jika id dan deviceId sudah ada, update data
        await connection.execute(
            `UPDATE whatsapp_auth_state SET data = ? WHERE id = ? AND deviceId = ?`,
            [JSON.stringify(data, BufferJSON.replacer), id, deviceId]
        );
    } else {
        console.log('Data tidak ditemukan, lakukan insert data', id, deviceId);
        // Jika id belum ada untuk deviceId tertentu, insert baru
        await connection.execute(
            `INSERT INTO whatsapp_auth_state (id, deviceId, data) VALUES (?, ?, ?)`,
            [id, deviceId, JSON.stringify(data, BufferJSON.replacer)]
        );
    }

    await connection.end();
};

// Fungsi untuk menghapus data dari database
const removeData = async (deviceId) => {
    const connection = await getConnection();
    await connection.execute('DELETE FROM whatsapp_auth_state WHERE deviceId = ?', [deviceId]);
    await connection.end();
};

// Menggunakan auth state berbasis MySQL
const useMySQLAuthState = async (deviceId) => {
    const creds = await readData(deviceId, 'creds') || initAuthCreds();

    const keys = {
        get: async (type, ids) => {
            const data = {};
            for (const id of ids) {
                let value = await readData(deviceId, `${type}-${id}`);
                if (type === 'app-state-sync-key' && value) {
                    value = fromObject(value);
                }
                data[id] = value;
            }
            return data;
        },
        set: async (data) => {
            for (const category in data) {
                for (const id in data[category]) {
                    const value = data[category][id];
                    if (value) {
                        await writeData(deviceId, `${category}-${id}`, value);
                    } else if (category !== 'creds') {  // Hanya hapus jika bukan creds
                        await removeData(deviceId, `${category}-${id}`);
                    }
                }
            }
        }
    };

    return {
        state: { creds, keys },
        saveCreds: async () => {
            if (!creds || Object.keys(creds).length === 0) {
                console.warn(`Creds kosong untuk ${deviceId}, tidak menyimpan.`);
                return;
            }
            console.log(`Menyimpan creds untuk ${deviceId}`);
            await writeData(deviceId, 'creds', creds);
        },
        removeCreds: async () => {
            await removeData(deviceId);
        }
    };
};

// Simpan daftar deviceId yang telah login
const saveDeviceId = async (deviceId) => {
    const connection = await getConnection();
    await connection.execute(
        `INSERT INTO whatsapp_sessions (deviceId) VALUES (?) ON DUPLICATE KEY UPDATE deviceId = VALUES(deviceId)`,
        [deviceId]
    );
    await connection.end();
};

const removeSession = async (deviceId) => {
    const connection = await getConnection();
    await connection.execute('DELETE FROM whatsapp_auth_state WHERE deviceId = ?', [deviceId]);
    await connection.execute('DELETE FROM whatsapp_sessions WHERE deviceId = ?', [deviceId]);
    await connection.end();
}

// Ambil semua deviceId yang sudah terhubung sebelumnya
const getAllDeviceIds = async () => {
    const connection = await getConnection();
    const [rows] = await connection.execute(`SELECT deviceId FROM whatsapp_sessions`);
    return rows.map(row => row.deviceId);
};

module.exports = { useMySQLAuthState, readData, writeData, removeData, removeSession, saveDeviceId, getAllDeviceIds  };
