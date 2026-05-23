import { createClient } from 'redis';
import { initAuthCreds, BufferJSON, proto } from 'baileys';
import 'dotenv/config';

const redisClient = createClient({
    url: `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`,
    password: process.env.REDIS_PASSWORD || undefined
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));

// Auto-connect to Redis when module is loaded
await redisClient.connect();

export const readData = async (key) => {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data, BufferJSON.reviver) : null;
};

export const writeData = async (key, data) => {
    if (!data) return;
    const json = JSON.stringify(data, BufferJSON.replacer);
    await redisClient.set(key, json);
};

export const removeData = async (key) => {
    await redisClient.del(key);
};

export const useRedisAuthState = async (deviceId) => {
    const credsKey = `wa-auth:${deviceId}:creds`;
    const creds = await readData(credsKey) || initAuthCreds();

    const keys = {
        get: async (type, ids) => {
            const data = {};
            if (ids.length === 0) return data;

            // Gunakan perintah MGET untuk mengambil banyak kunci sekaligus dengan kecepatan tinggi
            const keysToFetch = ids.map(id => `wa-auth:${deviceId}:${type}-${id}`);
            const values = await redisClient.mGet(keysToFetch);
            
            for (let i = 0; i < ids.length; i++) {
                let value = values[i] ? JSON.parse(values[i], BufferJSON.reviver) : null;
                if (type === 'app-state-sync-key' && value) {
                    value = proto.Message.AppStateSyncKeyData.fromObject(value);
                }
                data[ids[i]] = value;
            }
            return data;
        },
        set: async (data) => {
            // Gunakan pipeline (multi) untuk mengeksekusi penulisan/penghapusan banyak kunci sekaligus
            const multi = redisClient.multi();
            for (const category in data) {
                for (const id in data[category]) {
                    const value = data[category][id];
                    const key = `wa-auth:${deviceId}:${category}-${id}`;
                    if (value) {
                        multi.set(key, JSON.stringify(value, BufferJSON.replacer));
                    } else if (category !== 'creds') {
                        multi.del(key);
                    }
                }
            }
            await multi.exec();
        }
    };

    return {
        state: { creds, keys },
        saveCreds: async () => {
            if (!creds || Object.keys(creds).length === 0) return;
            await writeData(credsKey, creds);
        },
        removeCreds: async () => {
            await removeData(credsKey);
        }
    };
};

export const saveDeviceId = async (deviceId) => {
    await redisClient.sAdd('wa-sessions', String(deviceId));
};

export const removeSession = async (deviceId) => {
    // Hapus dari daftar sesi
    await redisClient.sRem('wa-sessions', String(deviceId));
    
    // Pindai dan hapus semua kunci yang berkaitan dengan deviceId ini
    let cursor = 0;
    do {
        const reply = await redisClient.scan(cursor, {
            MATCH: `wa-auth:${deviceId}:*`,
            COUNT: 100
        });
        cursor = reply.cursor;
        if (reply.keys.length > 0) {
            await redisClient.del(reply.keys);
        }
    } while (cursor !== 0);
};

export const getAllDeviceIds = async () => {
    return await redisClient.sMembers('wa-sessions');
};
