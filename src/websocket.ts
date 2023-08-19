import fs from "fs/promises";
import path from "path";
import URL from "url";
import WebSocket from "ws";
import mime from "mime";

type User = { username: string, userid: string, password: string, ips: Set<string> };
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
        const results = (await getUserFiles(user.userid)).filter(result => {
            // do something with data.value to filter the results
            return true;
        });
        const returnValue = { "type": "searchResults", "value": results, "query": data.value } as Packet;
        socket.send(JSON.stringify(returnValue));
    }
}

type UserFile = { identifier: string, type: string };
async function getUserFiles(userid: string): Promise<UserFile[]> {
    const userFilesDir = path.join("user_files/", userid);
    let userFiles: string[];
    try {
        userFiles = await fs.readdir(userFilesDir);
    } catch (e) {
        await fs.mkdir(userFilesDir);
        return [];
    }

    let results: UserFile[] = [];
    for (let userFile of userFiles) {
        const identifier = `${userid}/${path.parse(userFile).name}`;
        const type = mime.getType(userFile);
        results.push({ identifier, type: (type ?? "text/plain") });
    }
    return results;
}