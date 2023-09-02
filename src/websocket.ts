import URL from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import EventEmitter from "node:events";
import WebSocket from "ws";
import { User, UserFile } from "./database";

export const websocketEvents = new EventEmitter();

type Packet = { type?: string, value?: any };

export async function handleWebsocketMessage(
    socket: WebSocket,
    url: URL.UrlWithStringQuery,
    cookies: { [key: string]: string | undefined },
    authorized: boolean,
    user: User | undefined,
    rawData: WebSocket.RawData,
    isBinary: boolean
) {
    if (url.pathname === null) return;
    if (user === undefined) return;
    const data = JSON.parse(rawData.toString()) as Packet;
    if (data.type === undefined || data.value === undefined) return;
    if (data.type === "search") {
        const results = (await UserFile.fromUserId(user.userId)).filter(result => {
            // do something with data.value to filter the results
            return true;
        });
        const returnValue = { "type": "searchResults", "value": results.map(file => {
            const res = file.toObject();
            res.filesize = Number(res.filesize) as unknown as BigInt;
            return res;
        }), "query": data.value } as Packet;
        socket.send(JSON.stringify(returnValue));
    }

    if (data.type === "listenFile") {
        const listener = (msg: string) => {};
        websocketEvents.on("message", listener);
        socket.once("close", () => {
            websocketEvents.removeListener("message", listener);
        });
    }
}

// async function getUserFiles(userid: string): Promise<UserFile[]> {
//     const userFilesDir = path.join("user_files/", userid);
//     const userFilesRawDir = path.join(userFilesDir, "raw");
//     const userFilesDataDir = path.join(userFilesDir, "data");
//     let userFiles: string[];
//     try {
//         userFiles = await fs.readdir(userFilesDataDir);
//     } catch (e) {
//         await fs.mkdir(userFilesDir);
//         await fs.mkdir(userFilesRawDir);
//         await fs.mkdir(userFilesDataDir);
//         return [];
//     }

//     let results: UserFile[] = [];
//     for (let userFile of userFiles) {
//         const data = JSON.parse((await fs.readFile(path.join(userFilesDataDir, userFile))).toString());
//         const identifier = `${userid}/${userFile}`;
//         let type = data["mimeType"] ?? "text/plain";
//         if (!allowedMimeTypes.includes(type)) type = "text/plain";
//         const location = path.join(`/file/${identifier}`);
//         results.push({ identifier, type, location });
//     }
//     return results;
// }

// export async function generateUserFileId(userid: string) {
//     const userFilesDir = path.join("user_files/", userid);
//     const userFilesRawDir = path.join(userFilesDir, "raw");
//     const userFilesDataDir = path.join(userFilesDir, "data");

//     let userFiles: string[] = [];
//     try {
//         userFiles = await fs.readdir(userFilesDataDir);
//     } catch (e) {
//         await fs.mkdir(userFilesDir);
//         await fs.mkdir(userFilesRawDir);
//         await fs.mkdir(userFilesDataDir);
//     }

//     let fileId = "";
//     do {
//         fileId = Array.from(Array(32), () => fileIdChars[Math.floor(Math.random() * fileIdChars.length)]).join("");
//     } while (userFiles.includes(fileId));

//     return fileId;
// }

// const fileIdChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export async function writeUserFile(fileId: string, userid: string, filePath: string, _public: boolean) {
    const userFilesDir = path.join("user_files/", userid);
    const userFilesRawDir = path.join(userFilesDir, "raw");

    try {
        await fs.readdir(userFilesDir);
        await fs.readdir(userFilesRawDir);
    } catch (e) {
        await fs.mkdir(userFilesDir);
        await fs.mkdir(userFilesRawDir);
    }

    await fs.copyFile(filePath, path.join(userFilesRawDir, fileId));

    return `/file/${userid}/${fileId}`;
}