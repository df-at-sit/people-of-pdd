// backupFirestore.cjs
const fs = require("fs");
const admin = require("firebase-admin");

// either load from file:
const serviceAccount = JSON.parse(fs.readFileSync("./serviceAccountKey.json", "utf8"));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

// or, if you prefer env var:
// admin.initializeApp({ credential: admin.credential.applicationDefault() });

const db = admin.firestore();

async function backupCollections() {
    const collectionsToBackup = ["galleryCharacters", "mail", "subscribers"];
    const backup = {};

    for (const colName of collectionsToBackup) {
        const snapshot = await db.collection(colName).get();
        backup[colName] = snapshot.docs.map((doc) => ({
            id: doc.id,
            ...doc.data(),
        }));
        console.log(`✅ backed up ${snapshot.size} docs from "${colName}"`);
    }

    fs.writeFileSync("firestore-backup.json", JSON.stringify(backup, null, 2));
    console.log("📂 backup saved to firestore-backup.json");
}

backupCollections().catch((err) => {
    console.error("❌ backup failed:", err);
    process.exit(1);
});
