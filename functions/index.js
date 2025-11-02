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
// const { promisify } = require("util");
// const { execFile } = require("child_process");
// const execFileAsync = promisify(execFile);

// Favour the native fetch in Node 18+; lazily fall back to node-fetch for older runtimes.
const fetchFn = globalThis.fetch
    ? (...args) => globalThis.fetch(...args)
    : (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// ---- config ----
// change if your template places the texture elsewhere (e.g. "textures/poster.png")
const TEX_PATHS = {
    poster: path.join("textures", "poster.png"),
    name: path.join("textures", "name.png"),
    trait1: path.join("textures", "trait1.png"),
    trait2: path.join("textures", "trait2.png"),
    trait3: path.join("textures", "trait3.png"),
    trait4: path.join("textures", "trait4.png"),
};
const TRAIT_KEYS = ["trait1", "trait2", "trait3", "trait4"];
const STAGE_BASENAME = "animationtemplate.usdc";

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

    const normalize = (p) => p.replace(/\\/g, "/");

    async function addDir(rel) {
        const abs = path.join(srcDir, rel);
        const stats = await fsp.stat(abs);

        if (!stats.isDirectory()) {
            const data = await fsp.readFile(abs); // CRC + size now known
            zipfile.addBuffer(data, normalize(rel), {
                compress: false,
                mtime: stats.mtime,
                mode: stats.mode,
            });
            return;
        }

        if (rel) {
            const dirName = normalize(rel);
            const nameWithSlash = dirName.endsWith("/") ? dirName : `${dirName}/`;
            zipfile.addEmptyDirectory(nameWithSlash, {
                mtime: stats.mtime,
                mode: stats.mode,
            });
        }

        let entries = await fsp.readdir(abs);
        const enriched = await Promise.all(
            entries.map(async (name) => {
                const childAbs = path.join(abs, name);
                const childStats = await fsp.stat(childAbs);
                return { name, stats: childStats };
            })
        );

        enriched.sort((a, b) => {
            if (!rel) {
                const priority = (entry) => {
                    if (entry.name === STAGE_BASENAME) return -20;
                    if (entry.stats.isDirectory()) return 0;
                    return 10;
                };
                const pa = priority(a);
                const pb = priority(b);
                if (pa !== pb) return pa - pb;
            }
            return a.name.localeCompare(b.name);
        });

        for (const entry of enriched) {
            await addDir(path.join(rel, entry.name));
        }
    }

    await addDir("");

    await new Promise((resolve, reject) => {
        zipfile.outputStream
            .pipe(fs.createWriteStream(outUsdz))
            .on("close", resolve)
            .on("error", reject);
        zipfile.end();
    });
}

// --- main endpoint ---
// body: { posterDataUrl?: string, pngDataUrl?: string, pngUrl?: string, traitDataUrls?: string[], nameDataUrl?: string, displayName?: string }
app.options("/make-usdz", (_, res) => res.sendStatus(204)); // CORS preflight
app.post("/make-usdz", async (req, res) => {
    try {
        const { posterDataUrl, pngDataUrl, pngUrl, traitDataUrls, nameDataUrl, displayName } = req.body || {};
        const posterSrc = posterDataUrl || pngDataUrl || pngUrl;
        if (!posterSrc) {
            return res.status(400).json({ ok: false, error: "posterDataUrl or pngDataUrl required" });
        }
        const traitSrcs = Array.isArray(traitDataUrls) ? traitDataUrls : [];

        // local, checked-in template
        const templatePath = path.join(__dirname, "template", "animationtemplate.usdz");
        if (!fs.existsSync(templatePath)) {
            return res.status(500).json({ ok: false, error: "animationtemplate.usdz missing on server" });
        }

        // workspace
        const work = path.join(os.tmpdir(), `usdz-${Date.now()}`);
        const unpackDir = path.join(work, "unpacked");
        const outUsdz = path.join(work, "out.usdz");
        await unzipUsdZ(templatePath, unpackDir);

        async function replaceTexture(relPath, source) {
            if (!source) return;
            const tmp = await writePngTemp(source);
            const dest = path.join(unpackDir, relPath);
            await fsp.mkdir(path.dirname(dest), { recursive: true });
            await fsp.copyFile(tmp, dest);
        }

        await replaceTexture(TEX_PATHS.poster, posterSrc);
        await replaceTexture(TEX_PATHS.name, nameDataUrl);
        await Promise.all(
            TRAIT_KEYS.map((key, idx) => replaceTexture(TEX_PATHS[key], traitSrcs[idx]))
        );

        // optional cache buster
        // await fsp.writeFile(path.join(unpackDir, "version.txt"), String(Date.now()));

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
