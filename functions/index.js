// functions/index.js
/* eslint-disable */
const functions = require("firebase-functions/v1"); // ← v1 compat fixes "region is not a function"
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

// ---- init ----
admin.initializeApp();
const bucket = admin.storage().bucket();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "20mb" }));

// if your template contains "0/poster.png", keep this.
// if you re-exported your template as "textures/poster.png", change accordingly.
const TEX_PATH_IN_USDZ = path.join("0", "poster.png");

// helper: write PNG (from dataURL or https URL) to a temp file
async function writePngTemp(dataOrUrl) {
    const out = path.join(os.tmpdir(), `avatar-${Date.now()}.png`);
    if (typeof dataOrUrl === "string" && dataOrUrl.startsWith("data:image/")) {
        const b64 = dataOrUrl.split(",")[1] || "";
        await fsp.writeFile(out, Buffer.from(b64, "base64"));
        return out;
    }
    const resp = await fetch(dataOrUrl);
    if (!resp.ok) throw new Error(`png fetch failed: ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    await fsp.writeFile(out, buf);
    return out;
}

// unzip USDZ into a temp dir
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

// re-pack (STORE / no compression) into USDZ
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

    addDir(""); // add everything

    await new Promise((resolve, reject) => {
        zipfile.outputStream
            .pipe(fs.createWriteStream(outUsdz))
            .on("close", resolve)
            .on("error", reject);
        zipfile.end();
    });
}

// POST /make-usdz  { pngDataUrl?: string, pngUrl?: string, displayName?: string }
app.post("/make-usdz", async (req, res) => {
    try {
        const { pngDataUrl, pngUrl, displayName } = req.body || {};
        const src = pngDataUrl || pngUrl;
        if (!src) {
            return res.status(400).json({ ok: false, error: "pngDataUrl or pngUrl required" });
        }

        // use local, checked-in template copy
        const templatePath = path.join(__dirname, "template", "template.usdz");
        if (!fs.existsSync(templatePath)) {
            return res.status(500).json({ ok: false, error: "template.usdz missing on server" });
        }

        // workspace
        const work = path.join(os.tmpdir(), `usdz-${Date.now()}`);
        const unpackDir = path.join(work, "unpacked");
        const outUsdz = path.join(work, "out.usdz");
        await unzipUsdZ(templatePath, unpackDir);

        // overwrite the texture file inside the package
        const incomingPng = await writePngTemp(src);
        const texDest = path.join(unpackDir, TEX_PATH_IN_USDZ);
        await fsp.mkdir(path.dirname(texDest), { recursive: true });
        await fsp.copyFile(incomingPng, texDest);

        // tiny cache-buster file (optional)
        await fsp.writeFile(path.join(unpackDir, "version.txt"), String(Date.now()));

        // re-pack
        await zipUsdZFromDir(unpackDir, outUsdz);

        // upload to Firebase Storage (public)
        const safeName = (displayName || "character").replace(/[^\w\-]+/g, "_");
        const destPath = `usdz/${safeName}-${Date.now()}.usdz`;
        await bucket.upload(outUsdz, {
            destination: destPath,
            metadata: {
                contentType: "model/vnd.usdz+zip",
                cacheControl: "public,max-age=60",
            },
        });

        // build a **public** URL (no signed URLs; works great for Quick Look)
        // NOTE: your bucket is: people-of-pdd-website.firebasestorage.app (per your config)
        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${destPath}`;

        return res.json({ ok: true, usdzUrl: publicUrl });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: String(e) });
    }
});

// export 1st-gen HTTPS function in asia-southeast1
exports.api = functions.region("asia-southeast1").https.onRequest(app);
