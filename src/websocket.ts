import URL from "node:url";
import EventEmitter from "node:events";
import WebSocket from "ws";
import { User, UserFile } from "./database";

require("dotenv").config();

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
    if (url.pathname !== "/api") return;
    if (user === undefined) return;
    const data = JSON.parse(rawData.toString()) as Packet;
    if (data.type === undefined || data.value === undefined) return;
    if (data.type === "search") {
        const tags = String(data.value).split(",").map(tag => tag.trim());
        const results = (await UserFile.fromTags(tags)).filter(result => {
            // do something with data.value to filter the results
            if (result.userId !== user.userId && !result._public) return false;
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
