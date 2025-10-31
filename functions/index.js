// functions/index.js
/* eslint-disable */

const functions = require("firebase-functions/v1"); // v1 compat (region(), https.onRequest)
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const yauzl = require("yauzl");
const yazl = require("yazl");
const { randomUUID } = require("crypto");

// Favour the native fetch in Node 18+; lazily fall back to node-fetch for older runtimes.
const fetchFn = globalThis.fetch
    ? (...args) => globalThis.fetch(...args)
    : (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// ---- config ----
// change if your template places the texture elsewhere (e.g. "textures/poster.png")
const TEX_PATH_IN_USDZ = path.join("0", "poster.png");
const STAGE_BASENAME = "template.usdc";

// ---- init ----
admin.initializeApp();
const bucket = admin.storage().bucket();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "20mb" }));

// quick health check
app.get("/healthz", (_, res) => res.json({ ok: true }));

// --- helpers ---
async function writePngTemp(dataOrUrl) {
    const out = path.join(os.tmpdir(), `avatar-${Date.now()}.png`);
    if (typeof dataOrUrl === "string" && dataOrUrl.startsWith("data:image/")) {
        const b64 = dataOrUrl.split(",")[1] || "";
        await fsp.writeFile(out, Buffer.from(b64, "base64"));
        return out;
    }
    const resp = await fetchFn(dataOrUrl);
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

    function priorityForRootEntry(entry) {
        if (entry.name === STAGE_BASENAME) return -20; // ensure stage first
        if (entry.stats.isDirectory()) return 0;
        if (entry.name === "version.txt") return 20; // push cache buster to the end
        return 10; // other loose files after directories
    }

    function addDir(rel) {
        const abs = path.join(srcDir, rel);
        const stats = fs.statSync(abs);
        if (!stats.isDirectory()) {
            // USDZ requires STORE (no compression)
            zipfile.addFile(abs, rel.replace(/\\/g, "/"), { compress: false });
            return;
        }

        let entries = fs.readdirSync(abs).map((name) => ({
            name,
            stats: fs.statSync(path.join(abs, name)),
        }));

        if (!rel) {
            entries.sort((a, b) => {
                const pa = priorityForRootEntry(a);
                const pb = priorityForRootEntry(b);
                if (pa !== pb) return pa - pb;
                return a.name.localeCompare(b.name);
            });
        } else {
            entries.sort((a, b) => a.name.localeCompare(b.name));
        }

        if (rel) {
            const dirName = rel.replace(/\\/g, "/");
            const needsSlash = dirName.endsWith("/") ? dirName : `${dirName}/`;
            zipfile.addEmptyDirectory(needsSlash);
        }

        for (const entry of entries) {
            addDir(path.join(rel, entry.name));
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

// --- main endpoint ---
// body: { pngDataUrl?: string, pngUrl?: string, displayName?: string }
app.options("/make-usdz", (_, res) => res.sendStatus(204)); // CORS preflight
app.post("/make-usdz", async (req, res) => {
    try {
        const { pngDataUrl, pngUrl, displayName } = req.body || {};
        const src = pngDataUrl || pngUrl;
        if (!src) return res.status(400).json({ ok: false, error: "pngDataUrl or pngUrl required" });

        // local, checked-in template
        const templatePath = path.join(__dirname, "template", "template.usdz");
        if (!fs.existsSync(templatePath)) {
            return res.status(500).json({ ok: false, error: "template.usdz missing on server" });
        }

        // workspace
        const work = path.join(os.tmpdir(), `usdz-${Date.now()}`);
        const unpackDir = path.join(work, "unpacked");
        const outUsdz = path.join(work, "out.usdz");
        await unzipUsdZ(templatePath, unpackDir);

        // overwrite texture in the package
        const incomingPng = await writePngTemp(src);
        const texDest = path.join(unpackDir, TEX_PATH_IN_USDZ);
        await fsp.mkdir(path.dirname(texDest), { recursive: true });
        await fsp.copyFile(incomingPng, texDest);

        // optional cache buster
        await fsp.writeFile(path.join(unpackDir, "version.txt"), String(Date.now()));

        // repack
        await zipUsdZFromDir(unpackDir, outUsdz);

        // upload with token so it's publicly fetchable by iOS Quick Look
        const safeName = (displayName || "character").replace(/[^\w\-]+/g, "_");
        const destPath = `usdz/${safeName}-${Date.now()}.usdz`;
        const token = randomUUID();

        await bucket.upload(outUsdz, {
            destination: destPath,
            gzip: false,
            metadata: {
                contentType: "model/vnd.usdz+zip",
                cacheControl: "public,max-age=60",
                metadata: {
                    firebaseStorageDownloadTokens: token,
                },
            },
        });

        // Firebase tokenized download URL (works well on iOS)
        const encoded = encodeURIComponent(destPath);
        const usdzUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encoded}?alt=media&token=${token}`;

        return res.json({ ok: true, usdzUrl });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: String(e) });
    }
});

// export 1st-gen https function in asia-southeast1
exports.api = functions.region("asia-southeast1").https.onRequest(app);
