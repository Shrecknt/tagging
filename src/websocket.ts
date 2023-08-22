import fs from "node:fs/promises";
import path from "node:path";
import URL from "node:url";
import EventEmitter from "node:events";
import WebSocket from "ws";
import mime from "mime";
import { User } from "./database";

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
        const results = (await getUserFiles(user.userId)).filter(result => {
            // do something with data.value to filter the results
            return true;
        });
        const returnValue = { "type": "searchResults", "value": results, "query": data.value } as Packet;
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

const allowedMimeTypes = [
    "image/png",
    "image/jpg",
    "image/jpeg",
    "text/plain",
    "application/json",
    "application/octet-stream",
    "audio/aac",
    "image/avif",
    "application/vnd.amazon.ebook",
    "image/bmp",
    "application/x-bzip",
    "application/x-bzip2",
    "application/x-cdf",
    "application/x-csh",
    "text/css",
    "text/csv",
    "application/msword",
    "pplication/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-fontobject",
    "application/epub+zip",
    "application/gzip",
    "image/gif",
    "image/vnd.microsoft.icon",
    "text/calendar",
    "application/java-archive",
    "application/ld+json",
    "audio/midi",
    "audio/x-midi",
    "audio/mpeg",
    "video/mp4",
    "video/mpeg",
    "application/vnd.oasis.opendocument.presentation",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.text",
    "audio/ogg",
    "video/ogg",
    "application/ogg",
    "audio/opus",
    "font/otf",
    "application/pdf",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.rar",
    "application/rtf",
    "image/svg+xml",
    "application/x-tar",
    "image/tiff",
    "video/mp2t",
    "font/ttf",
    "application/vnd.visio",
    "audio/wav",
    "audio/webm",
    "video/webm",
    "image/webp",
    "font/woff",
    "font/woff2",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/xml",
    "text/xml",
    "application/vnd.mozilla.xul+xml",
    "application/zip",
    "video/3gpp",
    "audio/3gpp",
    "video/3gpp2",
    "audio/3gpp2",
    "application/x-7z-compressed"
];

type UserFile = { identifier: string, type: string, location: string };
async function getUserFiles(userid: string): Promise<UserFile[]> {
    const userFilesDir = path.join("user_files/", userid);
    const userFilesRawDir = path.join(userFilesDir, "raw");
    const userFilesDataDir = path.join(userFilesDir, "data");
    let userFiles: string[];
    try {
        userFiles = await fs.readdir(userFilesDataDir);
    } catch (e) {
        await fs.mkdir(userFilesDir);
        await fs.mkdir(userFilesRawDir);
        await fs.mkdir(userFilesDataDir);
        return [];
    }

    let results: UserFile[] = [];
    for (let userFile of userFiles) {
        const data = JSON.parse((await fs.readFile(path.join(userFilesDataDir, userFile))).toString());
        const identifier = `${userid}/${userFile}`;
        let type = data["mimeType"] ?? "text/plain";
        if (!allowedMimeTypes.includes(type)) type = "text/plain";
        const location = path.join(`/file/${identifier}`);
        results.push({ identifier, type, location });
    }
    return results;
}

export async function generateUserFileId(userid: string) {
    const userFilesDir = path.join("user_files/", userid);
    const userFilesRawDir = path.join(userFilesDir, "raw");
    const userFilesDataDir = path.join(userFilesDir, "data");

    let userFiles: string[] = [];
    try {
        userFiles = await fs.readdir(userFilesDataDir);
    } catch (e) {
        await fs.mkdir(userFilesDir);
        await fs.mkdir(userFilesRawDir);
        await fs.mkdir(userFilesDataDir);
    }

    let fileId = "";
    do {
        fileId = Array.from(Array(32), () => fileIdChars[Math.floor(Math.random() * fileIdChars.length)]).join("");
    } while (userFiles.includes(fileId));

    return fileId;
}

const fileIdChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export async function writeUserFile(fileId: string, userid: string, fileName: string, tags: string[], filePath: string, _public: boolean, mimeType?: string) {
    const userFilesDir = path.join("user_files/", userid);
    const userFilesRawDir = path.join(userFilesDir, "raw");
    const userFilesDataDir = path.join(userFilesDir, "data");

    const metaData = {
        fileName,
        mimeType: mimeType ?? mime.getType(fileName),
        tags,
        public: _public
    };

    await fs.copyFile(filePath, path.join(userFilesRawDir, fileId));
    await fs.writeFile(path.join(userFilesDataDir, fileId), JSON.stringify(metaData));

    return `/file/${userid}/${fileId}`;
}