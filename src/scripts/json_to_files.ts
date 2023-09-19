import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { useClient } from "../database";
import { UserFile } from "../database/file";

async function main() {
    const client = await useClient();
    await client.query("DELETE FROM files;");
    const userFilesDirs = await fs.readdir("user_files/");
    for (let userFilesDir of userFilesDirs) {
        const userFiles = await fs.readdir(path.join("user_files/", userFilesDir, "data/"));
        for (let userFileName of userFiles) {
            const userFilePath = path.join("user_files/", userFilesDir, "data/", userFileName);
            const userFile = JSON.parse((await fs.readFile(userFilePath)).toString()) as {
                fileName: string,
                mimeType?: string,
                tags: string[],
                public: boolean
            };
            const generatedUserFile = new UserFile(
                userFileName,
                userFilesDir,
                userFile.fileName,
                userFile.mimeType ?? null,
                userFile.tags,
                fsSync.statSync(userFilePath).size,
                userFile.fileName,
                "",
                (userFile.public ? 1 : 0),
                null
            );
            await generatedUserFile.writeChanges();
        }
    }
}
main().then(() => {
    console.log("Done.");
    process.exit(0);
}).catch(console.error);