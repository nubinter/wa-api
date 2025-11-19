import mysql from 'mysql2/promise';
import { initAuthCreds, BufferJSON, proto } from 'baileys';

const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'rulli_sakti',
    password: process.env.DB_PASSWORD || '$@kT1@)@!',
    database: process.env.DB_NAME || 'whatsapp_api',
};

const getConnection = async () => {
    return await mysql.createConnection(dbConfig);
};

export const readData = async (deviceId, id) => {
    const connection = await getConnection();
    const [rows] = await connection.execute(
        'SELECT data FROM whatsapp_auth_state WHERE deviceId = ? AND id = ?',
        [deviceId, id]
    );
    await connection.end();
    return rows.length > 0 ? JSON.parse(rows[0].data, BufferJSON.reviver) : null;
};

export const writeData = async (deviceId, id, data) => {
    if (!data) return;
    const connection = await getConnection();

    const [rows] = await connection.execute(
        'SELECT 1 FROM whatsapp_auth_state WHERE id = ? AND deviceId = ? LIMIT 1',
        [id, deviceId]
    );

    const json = JSON.stringify(data, BufferJSON.replacer);

    if (rows.length > 0) {
        await connection.execute(
            'UPDATE whatsapp_auth_state SET data = ? WHERE id = ? AND deviceId = ?',
            [json, id, deviceId]
        );
    } else {
        await connection.execute(
            'INSERT INTO whatsapp_auth_state (id, deviceId, data) VALUES (?, ?, ?)',
            [id, deviceId, json]
        );
    }

    await connection.end();
};

export const removeData = async (deviceId, id) => {
    const connection = await getConnection();
    if (id) {
        await connection.execute(
            'DELETE FROM whatsapp_auth_state WHERE deviceId = ? AND id = ?',
            [deviceId, id]
        );
    } else {
        await connection.execute(
            'DELETE FROM whatsapp_auth_state WHERE deviceId = ?',
            [deviceId]
        );
    }
    await connection.end();
};

export const useMySQLAuthState = async (deviceId) => {
    const creds = await readData(deviceId, 'creds') || initAuthCreds();

    const keys = {
        get: async (type, ids) => {
            const data = {};
            for (const id of ids) {
                let value = await readData(deviceId, `${type}-${id}`);
                if (type === 'app-state-sync-key' && value) {
                    value = proto.Message.AppStateSyncKeyData.fromObject(value);
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
                    } else if (category !== 'creds') {
                        await removeData(deviceId, `${category}-${id}`);
                    }
                }
            }
        }
    };

    return {
        state: { creds, keys },
        saveCreds: async () => {
            if (!creds || Object.keys(creds).length === 0) return;
            await writeData(deviceId, 'creds', creds);
        },
        removeCreds: async () => {
            await removeData(deviceId);
        }
    };
};

export const saveDeviceId = async (deviceId) => {
    const connection = await getConnection();
    await connection.execute(
        'INSERT INTO whatsapp_sessions (deviceId) VALUES (?) ON DUPLICATE KEY UPDATE deviceId = VALUES(deviceId)',
        [deviceId]
    );
    await connection.end();
};

export const removeSession = async (deviceId) => {
    const connection = await getConnection();
    await connection.execute(
        'DELETE FROM whatsapp_auth_state WHERE deviceId = ?',
        [deviceId]
    );
    await connection.execute(
        'DELETE FROM whatsapp_sessions WHERE deviceId = ?',
        [deviceId]
    );
    await connection.end();
};

export const getAllDeviceIds = async () => {
    const connection = await getConnection();
    const [rows] = await connection.execute('SELECT deviceId FROM whatsapp_sessions');
    await connection.end();
    return rows.map(row => row.deviceId);
};
