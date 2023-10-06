import http, { get } from "node:http";
import * as URL from "node:url";
import * as DB from "./database";

export async function handleApiRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ip: string,
    cookies: { [key: string]: string | undefined },
    user: DB.User | undefined,
    authorized: boolean,
    url: URL.UrlWithStringQuery
): Promise<boolean> {
    const apiPath = (url.pathname?.split("/") ?? []).splice(2);

    let body = (await readBody(req)) ?? "{}";
    if (body === "") body = "{}";

    const args: { [key: string]: any } = JSON.parse(body);
    const query = (url.query?.split("&").map(str => {
        let split = str.split("=");
        return [split[0], split.splice(1).join("=")];
    }).reduce((accum: any, val) => {
        accum[decodeURIComponent(val[0]).toLowerCase()]
            = decodeURIComponent(val[1]).toLowerCase();
        return accum;
    }, {})) ?? {};
    function nullishArg(argName: string): string | null {
        if (query[argName.toLowerCase()] !== undefined) return query[argName.toLowerCase()];
        const getArg = args[argName];
        if (typeof getArg === "string") {
            return getArg;
        }
        return null;
    }
    function arg(argName: string): string {
        const result = nullishArg(argName);
        if (result === null) throw `Missing argument '${argName}'`;
        return result;
    }

    const head = (res: http.ServerResponse) => res.writeHead(200, { "Content-Type": "application/json" });
    const write = (res: http.ServerResponse, data: any) => res.write(JSON.stringify({ "error": "", "data": data }, (key, value) => (typeof value === "bigint" ? value.toString() : value), 4));

    switch (apiPath[0].toLowerCase()) {
        case "session":
            const sessionId = apiPath[1] ?? arg("sessionID");
            const expires = (await DB.Session.fromSessionId(sessionId))?.expires as number;
            res.writeHead(303, {
                "Location": "/profile",
                "Set-Cookie": `Authorization=${encodeURIComponent(sessionId)}; SameSite=Strict; Secure; HttpOnly; Path=/; Expires=${new Date(expires).toUTCString()}`
            });
            res.write("Account successfully created");
            res.end();
            return true;
        case "user":
            let user;
            let userObj;
            switch (apiPath[1].toLowerCase()) {
                case "id":
                    user = await DB.User.fromUserId(apiPath[2] ?? arg("id"));
                    if (user === undefined) throw "User not found";
                    userObj = user.toObject() as any;
                    delete userObj.password;
                    delete userObj.ips;
                    head(res);
                    write(res, userObj);
                    res.end();
                    return true;
                case "username":
                    user = await DB.User.fromUsername(apiPath[2] ?? arg("username"));
                    if (user === undefined) throw "User not found";
                    userObj = user.toObject() as any;
                    delete userObj.password;
                    delete userObj.ips;
                    head(res);
                    write(res, userObj);
                    res.end();
                    return true;
            }
            break;
        case "file":
            let file;
            let fileObj;
            switch (apiPath[1].toLowerCase()) {
                case "id":
                    file = await DB.UserFile.fromFileId(apiPath[2] ?? arg("id"))
                        ?? await DB.UserFile.fromShortUrl(apiPath[2] ?? arg("id"));
                    if (file === undefined || file.visibility < 1) throw "File not found";
                    fileObj = file.toObject() as any;
                    head(res);
                    write(res, fileObj);
                    res.end();
                    return true;
                case "userid":
                    file = await DB.UserFile.fromUserId(arg("userid"), [], parseInt(arg("page"), 10), 8, true);
                    fileObj = file.map(f => f.toObject()) as any[];
                    head(res);
                    write(res, fileObj);
                    res.end();
                    return true;
                case "tags":
                    file = await DB.UserFile.fromTags(arg("tags").split(/[\,\ ]/g), parseInt(arg("page"), 10), 8);
                    fileObj = file.map(f => f.toObject()) as any[];
                    head(res);
                    write(res, fileObj);
                    res.end();
                    return true;
            }
            break;
    }

    if (authorized && user !== undefined && user.permissionLevel >= 5) {
        if (apiPath[0].toLowerCase() === "admin") {
            switch (apiPath[1].toLowerCase()) {
                case "generatesession":
                    const sessionUser = await DB.User.fromUserId(arg("userId"));
                    if (sessionUser === undefined) throw "No user with given user ID";
                    const expiresIn = Number(nullishArg("expiresIn")) || 3600000;
                    const session = await DB.Session.createSession(sessionUser, expiresIn);
                    head(res);
                    write(res, { sessionId: session.sessionId });
                    res.end();
                    return true;
            }
        }
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.write(JSON.stringify({ "error": `Unknown endpoint '/${apiPath.join("/")}'` }));
    res.end();
    return true;
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise(async (res, rej) => {
        let body: string = "";
        req.on("data", (chunk) => {
            body += chunk;
        });
        req.on("end", () => {
            res(body);
        });
        req.on("error", (err) => {
            rej(err);
        });
    });
}
