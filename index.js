const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    getContentType,
    makeCacheableSignalKeyStore,
    downloadContentFromMessage,
    jidNormalizedUser
} = require("baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const util = require("util");
const fs = require("node:fs");
const { tmpdir } = require("os");
const Crypto = require("crypto");
const ff = require("fluent-ffmpeg");
const { exec } = require("child_process");
const webp = require("node-webpmux");
const path = require("path");

let starttime = new Date();

async function startBot() {
    let { state, saveCreds } = await useMultiFileAuthState(".session");
    let clients = makeWASocket({
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        version: [2, 3000, 1033846690],
        browser: ["Linux", "Chrome", ""],
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(
                state.keys,
                pino({ level: "silent" })
            )
        },
        generateHighQualityLinkPreview: true
    });

    if (!clients.authState.creds.registered) {
        let phoneNumber = "6281276400345";
        setTimeout(async () => {
            let code = await clients.requestPairingCode(phoneNumber);
            console.log(code.match(/.{1,4}/g).join("-"));
        }, 3000);
    }

    clients.ev.on("connection.update", async update => {
        let { connection, lastDisconnect } = update;
        if (connection === "close") {
            let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut)
                setTimeout(startBot, 5000);
        } else if (connection === "open") console.log("CONNECTED");
    });

    clients.ev.on("creds.update", saveCreds);

    clients.ev.on("messages.upsert", async ({ messages }) => {
        try {
            let m = serialize(clients, messages[0]);
            //console.log(messages)

            /** READ SW **/
            if (
                m.key &&
                m.key.remoteJid === "status@broadcast" &&
                m.message &&
                !m.key.fromMe &&
                m.mtype !== "protocolMessage"
            ) {
                await clients.readMessages([
                    {
                        remoteJid: "status@broadcast",
                        id: m.key.id,
                        participant: m.key.remoteJidAlt
                    }
                ]);
                await clients.sendMessage("status@broadcast", {
                    react: {
                        key: {
                            remoteJid: "status@broadcast",
                            id: m.key.id,
                            participant: m.key.remoteJidAlt
                        },
                        text: "🩵"
                    },
                    statusJidList: [m.key.remoteJidAlt]
                });
            }
            /** END READ SW **/

            console.log(
                `${m.key.participant || m.key.remoteJid} -> ${m.chat}\n${m.body?.trim() || ""}\n${"──".repeat(20)}`
            );
            if (!m.body) return;
            if (
                m.key.participant !== "144693639798968@lid" &&
                m.key.remoteJid !== "144693639798968@lid" &&
                m.chat !== "120363427404118528@g.us"
            )
                return;

            let [cmd, ...args] = m.body.trim().split(" ");
            cmd = cmd.toLowerCase();

            switch (cmd) {
                case "sticker":
                case "s":
                    {
                        let quoted =
                            m.message?.extendedTextMessage?.contextInfo
                                ?.quotedMessage;
                        let type = quoted ? Object.keys(quoted)[0] : m.mtype;
                        let media = quoted ? quoted[type] : m.message[type];
                        if (!type) return m.reply("reply image/video/sticker");
                        if (!/image|video|sticker/.test(type))
                            return m.reply("reply image/video/sticker");
                        if (!media || (!media.url && !media.directPath))
                            return m.reply("reply image/video/sticker");
                        let stream = await downloadContentFromMessage(
                            media,
                            type.replace("Message", "")
                        );
                        let buffer = Buffer.from([]);
                        for await (let chunk of stream)
                            buffer = Buffer.concat([buffer, chunk]);
                        let result;
                        if (/image/.test(type))
                            result = await writeExifImg(buffer, {
                                packname: "My stc",
                                author: "balxzzy"
                            });
                        else if (/video/.test(type))
                            result = await writeExifVid(buffer, {
                                packname: "My stc",
                                author: "balxzzy"
                            });
                        else if (/sticker/.test(type))
                            result = await writeExif(
                                { mimetype: "image/webp", data: buffer },
                                { packname: "My stc", author: "balxzzy" }
                            );
                        let stickerBuffer = fs.readFileSync(result);
                        await clients.sendMessage(
                            m.chat,
                            { sticker: stickerBuffer },
                            { quoted: m }
                        );
                        fs.unlinkSync(result);
                    }
                    break;

                case "brat":
                    {
                        let text = m.body.slice(cmd.length).trim();
                        if (!text) return m.reply("isi text");
                        let url = `https://brat.siputzx.my.id/image?text=${encodeURIComponent(text)}`;
                        let res = await fetch(url);
                        let buffer = Buffer.from(await res.arrayBuffer());
                        let sticker = await writeExifImg(buffer, {
                            packname: "My Stc",
                            author: "balxzzy"
                        });
                        let stickerBuffer = fs.readFileSync(sticker);
                        await clients.sendMessage(
                            m.chat,
                            { sticker: stickerBuffer },
                            { quoted: m }
                        );
                        fs.unlinkSync(sticker);
                    }
                    break;

                case "bratvid":
                    {
                        let text = m.body.slice(cmd.length).trim();
                        if (!text) return m.reply("isi text");
                        let url = `https://brat.siputzx.my.id/gif?text=${encodeURIComponent(text)}`;
                        let res = await fetch(url);
                        let buffer = Buffer.from(await res.arrayBuffer());
                        let stickerWebp = await videoToWebp(buffer);
                        let sticker = await writeExif(
                            { mimetype: "image/webp", data: stickerWebp },
                            {
                                packname: "My Stc",
                                author: "balxzzy"
                            }
                        );
                        let stickerBuffer = fs.readFileSync(sticker);
                        await clients.sendMessage(
                            m.chat,
                            { sticker: stickerBuffer },
                            { quoted: m }
                        );
                        fs.unlinkSync(sticker);
                    }
                    break;

                case "rt":
                    {
                        let uptime = (Date.now() - starttime) / 1000;
                        m.reply(formatRuntime(uptime));
                    }
                    break;

                case "ev":
                    {
                        if (
                            m.key.participant !== "144693639798968@lid" &&
                            m.key.remoteJid !== "144693639798968@lid"
                        )
                            return;
                        try {
                            let evaled = await eval(
                                `(async () => { ${args.join(" ")} })()`
                            );
                            if (typeof evaled !== "string")
                                evaled = util.inspect(evaled);
                            await m.reply(evaled);
                        } catch (err) {
                            await m.reply(String(err));
                        }
                    }
                    break;

                case "exc":
                    {
                        if (
                            m.key.participant !== "144693639798968@lid" &&
                            m.key.remoteJid !== "144693639798968@lid"
                        )
                            return;
                        let code = m.body.slice(cmd.length).trim();
                        if (!code) return;
                        exec(code, (err, stdout, stderr) => {
                            let res = stdout || stderr || err;
                            if (typeof res !== "string")
                                res = util.inspect(res);
                            m.reply(res);
                        });
                    }
                    break;
            }
        } catch (err) {
            console.log(err);
        }
    });
}

startBot();

function serialize(clients, m) {
    if (!m) return m;
    if (m.key) m.chat = m.key.remoteJid;
    if (m.message) {
        let mtype = getContentType(m.message);
        let msg = m.message[mtype];
        if (mtype === "ephemeralMessage") {
            mtype = getContentType(msg.message);
            msg = msg.message[mtype];
        }
        if (mtype === "viewOnceMessage") {
            mtype = getContentType(msg.message);
            msg = msg.message[mtype];
        }
        m.mtype = mtype;
        m.msg = msg;
        m.body =
            (m?.mtype === "conversation"
                ? m?.message?.conversation
                : m?.mtype === "imageMessage"
                  ? m?.message?.imageMessage?.caption
                  : m?.mtype === "videoMessage"
                    ? m?.message?.videoMessage?.caption
                    : m?.mtype === "extendedTextMessage"
                      ? m?.message?.extendedTextMessage?.text
                      : m?.mtype === "documentMessage"
                        ? m?.message?.documentMessage?.caption
                        : "") || "";
        m.reply = text => clients.sendMessage(m.chat, { text }, { quoted: m });
    }

    return m;
}

function formatRuntime(sec) {
    let d = Math.floor(sec / 86400);
    let h = Math.floor((sec % 86400) / 3600);
    let m = Math.floor((sec % 3600) / 60);
    let s = Math.floor(sec % 60);
    return [d && d + "d", h && h + "h", m && m + "m", s && s + "s"]
        .filter(Boolean)
        .join(" ");
}

async function imageToWebp(media) {
    let tmpFileOut = path.join(
        tmpdir(),
        `${Crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.webp`
    );
    let tmpFileIn = path.join(
        tmpdir(),
        `${Crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.jpg`
    );
    fs.writeFileSync(tmpFileIn, media);
    await new Promise((resolve, reject) => {
        ff(tmpFileIn)
            .on("error", reject)
            .on("end", () => resolve(true))
            .addOutputOptions([
                "-vcodec",
                "libwebp",
                "-vf",
                "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease,fps=15"
            ])
            .toFormat("webp")
            .save(tmpFileOut);
    });
    let buff = fs.readFileSync(tmpFileOut);
    fs.unlinkSync(tmpFileOut);
    fs.unlinkSync(tmpFileIn);
    return buff;
}

async function videoToWebp(media) {
    let tmpFileOut = path.join(
        tmpdir(),
        `${Crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.webp`
    );
    let tmpFileIn = path.join(
        tmpdir(),
        `${Crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.mp4`
    );
    fs.writeFileSync(tmpFileIn, media);
    await new Promise((resolve, reject) => {
        ff(tmpFileIn)
            .on("error", reject)
            .on("end", () => resolve(true))
            .addOutputOptions([
                "-vcodec",
                "libwebp",
                "-vf",
                "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease,fps=15",
                "-loop",
                "0",
                "-ss",
                "00:00:00",
                "-t",
                "00:00:05",
                "-preset",
                "default",
                "-an",
                "-vsync",
                "0"
            ])
            .toFormat("webp")
            .save(tmpFileOut);
    });
    let buff = fs.readFileSync(tmpFileOut);
    fs.unlinkSync(tmpFileOut);
    fs.unlinkSync(tmpFileIn);
    return buff;
}

async function writeExifImg(media, metadata) {
    let wMedia = await imageToWebp(media);
    let tmpFileIn = path.join(
        tmpdir(),
        `${Crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.webp`
    );
    let tmpFileOut = path.join(
        tmpdir(),
        `${Crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.webp`
    );
    fs.writeFileSync(tmpFileIn, wMedia);
    let img = new webp.Image();
    let json = {
        "sticker-pack-id": "",
        "sticker-pack-name": metadata.packname,
        "sticker-pack-publisher": metadata.author,
        emojis: [""]
    };
    let exifAttr = Buffer.from([
        0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
        0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00
    ]);
    let jsonBuff = Buffer.from(JSON.stringify(json), "utf-8");
    let exif = Buffer.concat([exifAttr, jsonBuff]);
    exif.writeUIntLE(jsonBuff.length, 14, 4);
    await img.load(tmpFileIn);
    fs.unlinkSync(tmpFileIn);
    img.exif = exif;
    await img.save(tmpFileOut);
    return tmpFileOut;
}

async function writeExifVid(media, metadata) {
    let wMedia = await videoToWebp(media);
    let tmpFileIn = path.join(
        tmpdir(),
        `${Crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.webp`
    );
    let tmpFileOut = path.join(
        tmpdir(),
        `${Crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.webp`
    );
    fs.writeFileSync(tmpFileIn, wMedia);
    let img = new webp.Image();
    let json = {
        "sticker-pack-id": "",
        "sticker-pack-name": metadata.packname,
        "sticker-pack-publisher": metadata.author,
        emojis: [""]
    };
    let exifAttr = Buffer.from([
        0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
        0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00
    ]);
    let jsonBuff = Buffer.from(JSON.stringify(json), "utf-8");
    let exif = Buffer.concat([exifAttr, jsonBuff]);
    exif.writeUIntLE(jsonBuff.length, 14, 4);
    await img.load(tmpFileIn);
    fs.unlinkSync(tmpFileIn);
    img.exif = exif;
    await img.save(tmpFileOut);
    return tmpFileOut;
}

async function writeExif(media, metadata) {
    let tmpFileIn = path.join(
        tmpdir(),
        `${Crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.webp`
    );
    let tmpFileOut = path.join(
        tmpdir(),
        `${Crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.webp`
    );
    fs.writeFileSync(tmpFileIn, media.data);
    let img = new webp.Image();
    let json = {
        "sticker-pack-id": "",
        "sticker-pack-name": metadata.packname,
        "sticker-pack-publisher": metadata.author,
        emojis: metadata.categories ? metadata.categories : [""]
    };
    let exifAttr = Buffer.from([
        0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
        0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00
    ]);
    let jsonBuff = Buffer.from(JSON.stringify(json), "utf-8");
    let exif = Buffer.concat([exifAttr, jsonBuff]);
    exif.writeUIntLE(jsonBuff.length, 14, 4);
    await img.load(tmpFileIn);
    fs.unlinkSync(tmpFileIn);
    img.exif = exif;
    await img.save(tmpFileOut);
    return tmpFileOut;
}
