import express from 'express';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { 
    makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    makeCacheableSignalKeyStore, 
    Browsers, 
    jidNormalizedUser, 
    fetchLatestBaileysVersion 
} from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';
import FormData from 'form-data';
import fetch from 'node-fetch';

const router = express.Router();

// --- CONFIGURATION ---
// You can replace this with your own API key if this one hits limits
const PASTEBIN_API_KEY = 'KDa3QFh5XE1G3W1VrhmiK8ks0LpnbIi7'; 

// --- UTILITY FUNCTIONS ---

function removeFile(directoryPath) {
    try {
        if (fs.existsSync(directoryPath)) {
            fs.rmSync(directoryPath, { recursive: true, force: true });
        }
    } catch (e) {
        console.error('Error removing file:', e);
    }
}

// 1. Pastebin Upload (Fixed to return RAW link)
async function uploadToPastebin(filePath) {
    try {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        
        // Validation: Ensure we are uploading JSON
        try { JSON.parse(fileContent); } 
        catch { throw new Error("File content is not valid JSON"); }

        const formData = new FormData();
        formData.append('api_dev_key', PASTEBIN_API_KEY);
        formData.append('api_option', 'paste');
        formData.append('api_paste_code', fileContent);
        formData.append('api_paste_name', 'creds.json');
        formData.append('api_paste_format', 'json');
        formData.append('api_paste_private', '1'); // Unlisted
        formData.append('api_paste_expire_date', '1D'); 

        const response = await fetch('https://pastebin.com/api/api_post.php', {
            method: 'POST',
            body: formData
        });

        const link = await response.text();
        
        if (link.startsWith('https://pastebin.com/')) {
            // CRITICAL FIX: Convert to RAW link immediately
            return link.replace('https://pastebin.com/', 'https://pastebin.com/raw/');
        } else {
            throw new Error(`Pastebin Error: ${link}`);
        }
    } catch (error) {
        console.error('Pastebin upload error:', error.message);
        throw error;
    }
}

// 2. 0x0.st Upload (Simple & Reliable)
async function uploadTo0x0(filePath) {
    try {
        const fileBuffer = fs.readFileSync(filePath);
        const response = await fetch('https://0x0.st', {
            method: 'POST',
            body: fileBuffer
        });

        if (response.ok) {
            const url = await response.text();
            return url.trim();
        } else {
            throw new Error(`0x0.st failed: ${response.statusText}`);
        }
    } catch (error) {
        console.error('0x0.st upload error:', error.message);
        throw error;
    }
}

// Main Upload Handler
async function uploadCredsFile(dirPath) {
    const credsPath = path.join(dirPath, 'creds.json');
    
    // Wait a moment to ensure file is flushed to disk
    await delay(1000);

    if (!fs.existsSync(credsPath)) {
        throw new Error('creds.json file was not found!');
    }

    // Try Pastebin first, then 0x0.st
    const services = [
        { name: 'Pastebin', func: () => uploadToPastebin(credsPath) },
        { name: '0x0.st', func: () => uploadTo0x0(credsPath) }
    ];

    for (const service of services) {
        try {
            console.log(`📤 Uploading to ${service.name}...`);
            const url = await service.func();
            console.log(`✅ Uploaded to ${service.name}: ${url}`);
            return url;
        } catch (err) {
            console.log(`⚠️ ${service.name} failed, trying next...`);
        }
    }

    throw new Error('All upload services failed.');
}


// --- ROUTER LOGIC ---

router.get('/', async (req, res) => {
    let num = req.query.number;
    if (!num) return res.status(418).send({ message: 'Phone number is required' });

    const sessionDir = path.join(process.cwd(), `session-${num}`);
    
    // Clean previous attempts
    if (fs.existsSync(sessionDir)) removeFile(sessionDir);

    // Format Phone Number
    num = num.replace(/[^0-9]/g, '');
    const phone = pn('+' + num);
    if (!phone.isValid()) {
        return res.status(400).send({ message: 'Invalid phone number provided.' });
    }
    num = phone.getNumber('e164').replace('+', '');

    async function startSession() {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        try {
            const { version } = await fetchLatestBaileysVersion();
            
            const sock = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.windows('Chrome'),
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                connectTimeoutMs: 60000,
            });

            // Handle Pairing Code
            if (!sock.authState.creds.registered) {
                await delay(1500);
                try {
                    let code = await sock.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    
                    if (!res.headersSent) {
                        res.send({ code: code });
                    }
                } catch (err) {
                    console.error('Pairing code error:', err);
                    if (!res.headersSent) res.status(503).send({ message: 'Service Unavailable' });
                }
            }

            // Handle Connection Events
            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;

                if (connection === 'open') {
                    console.log(`✅ Connected: ${num}`);
                    
                    // Wait for creds to fully save
                    await delay(2000); 

                    try {
                        const downloadLink = await uploadCredsFile(sessionDir);
                        const userJid = jidNormalizedUser(sock.user.id);

                        // Send Instructions to User's WhatsApp
                        const msg = `*SESSION GENERATED* ✅\n\nUse this link in your ENV file:\n\n${downloadLink}\n\n_Keep this link private!_`;
                        
                        await sock.sendMessage(userJid, { text: msg });
                        await sock.sendMessage(userJid, { text: `SESSION_URL=${downloadLink}` });

                        console.log(`✅ Session sent to ${num}`);
                    } catch (err) {
                        console.error('❌ Upload failed:', err);
                    }

                    // Cleanup after short delay
                    await delay(5000);
                    await sock.end();
                    removeFile(sessionDir);
                }

                if (connection === 'close') {
                    const code = lastDisconnect?.error?.output?.statusCode;
                    // Restart if not logged out
                    if (code !== 401 && code !== 403) {
                        startSession();
                    }
                }
            });

            sock.ev.on('creds.update', saveCreds);

        } catch (err) {
            console.error(err);
        }
    }

    startSession();
});

export default router;
