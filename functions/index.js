/* eslint-disable */
"use strict";

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const yauzl = require("yauzl");
const yazl = require("yazl");

admin.initializeApp();
const bucket = admin.storage().bucket(); // default Firebase bucket

// ---------- helpers ----------
async function writePngTemp(dataOrUrl) {
    const out = path.join(os.tmpdir(), `avatar-${Date.now()}.png`);
    if (typeof dataOrUrl === "string" && dataOrUrl.startsWith("data:image/")) {
        const b64 = dataOrUrl.split(",")[1];
        await fsp.writeFile(out, Buffer.from(b64, "base64"));
        return out;
    }
    const resp = await fetch(dataOrUrl);
    if (!resp.ok) throw new Error(`png fetch failed: ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    await fsp.writeFile(out, buf);
    return out;
}

async function unzipUsdZ(usdzPath, outDir) {
    await fsp.mkdir(outDir, { recursive: true });
    await new Promise((resolve, reject) => {
        yauzl.open(usdzPath, { lazyEntries: true }, (err, zip) => {
            if (err) return reject(err);
            zip.readEntry();
            zip.on("entry", (entry) => {
                const dest = path.join(outDir, entry.fileName);
                if (/\/$/.test(entry.fileName)) {
                    fs.mkdirSync(dest, { recursive: true });
                    zip.readEntry();
                } else {
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    zip.openReadStream(entry, (err2, rs) => {
                        if (err2) return reject(err2);
                        const ws = fs.createWriteStream(dest);
                        rs.pipe(ws);
                        ws.on("close", () => zip.readEntry());
                    });
                }
            });
            zip.on("end", resolve);
            zip.on("error", reject);
        });
    });
}

async function zipUsdZFromDir(srcDir, outUsdz) {
    await fsp.mkdir(path.dirname(outUsdz), { recursive: true });
    const zipfile = new yazl.ZipFile();
    function addDir(rel) {
        const abs = path.join(srcDir, rel);
        const stats = fs.statSync(abs);
        if (stats.isDirectory()) {
            const items = fs.readdirSync(abs);
            if (rel && !rel.endsWith("/")) zipfile.addEmptyDirectory(rel + "/");
            for (const it of items) addDir(path.join(rel, it));
        } else {
            zipfile.addFile(abs, rel.replace(/\\/g, "/"), { compress: false }); // STORE
        }
    }
    addDir("");
    await new Promise((resolve, reject) => {
        zipfile.outputStream
            .pipe(fs.createWriteStream(outUsdz))
            .on("close", resolve)
            .on("error", reject);
        zipfile.end();
    });
}

// ---------- app ----------
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "20mb" }));

// POST /make-usdz  { pngDataUrl?: string, pngUrl?: string, displayName?: string }
app.post("/make-usdz", async (req, res) => {
    try {
        const { pngDataUrl, pngUrl, displayName } = req.body || {};
        const src = pngDataUrl || pngUrl;
        if (!src) {
            return res.status(400).json({ ok: false, error: "pngDataUrl or pngUrl required" });
        }

        // 1) template on disk (checked into repo at functions/template/template.usdz)
        const templatePath = path.join(__dirname, "template", "template.usdz");
        if (!fs.existsSync(templatePath)) {
            return res.status(500).json({ ok: false, error: "template.usdz missing on server" });
        }

        // 2) workspace
        const work = path.join(os.tmpdir(), `usdz-${Date.now()}`);
        const unpackDir = path.join(work, "unpacked");
        const outUsdz = path.join(work, "out.usdz");
        await unzipUsdZ(templatePath, unpackDir);

        // 3) drop in the incoming PNG to textures/poster.png
        const incomingPng = await writePngTemp(src);
        const texDest = path.join(unpackDir, "textures", "poster.png"); // must match inside template
        await fsp.copyFile(incomingPng, texDest);

        // minor cache marker
        await fsp.writeFile(path.join(unpackDir, "version.txt"), String(Date.now()));

        // 4) re-pack as USDZ (STORE)
        await zipUsdZFromDir(unpackDir, outUsdz);

        // 5) upload to Storage and make it PUBLIC
        const safeName = (displayName || "character").replace(/[^\w-]+/g, "_");
        const destPath = `usdz/${safeName}-${Date.now()}.usdz`;
        await bucket.upload(outUsdz, {
            destination: destPath,
            metadata: {
                contentType: "model/vnd.usdz+zip",
                cacheControl: "public,max-age=60",
            },
        });
        const file = bucket.file(destPath);
        await file.makePublic();
        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${destPath}`;

        return res.json({ ok: true, usdzUrl: publicUrl });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: String(e) });
    }
});

// 1st-gen HTTPS function (adjust region if you prefer)
exports.api = functions.region("asia-southeast1").https.onRequest(app);
