import http from "node:http";
import * as URL from "node:url";
import formidable from "formidable";
import * as DB from "./database";
import mime from "mime";

export async function handleForm(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ip: string,
    cookies: { [key: string]: string | undefined },
    user: DB.User | undefined,
    authorized: boolean,
    url: URL.UrlWithStringQuery
) {
    const form = formidable({});
    let fields: formidable.Fields;
    let files: formidable.Files;
    try {
        [fields, files] = await form.parse(req);
    } catch (err) {
        console.error(err);
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end();
        return;
    }

    const arg = (argName: string) => {
        const res = fields[argName];
        if (res === undefined) throw `Missing field '${argName}' (fields: ${JSON.stringify(fields)})`;
        if (res[0] === undefined) throw `Empty array found for field '${argName}' (fields: ${JSON.stringify(fields)})`;
        return res[0];
    };

    if (url.pathname === "/signup" && !authorized) {
        const [username, password] = [arg("username"), arg("password")];
        if (username === undefined
            || password === undefined
            || username.includes("\n")
            || password.includes("\n")
            || !/^[!-~]{3,16}$/m.test(username)
            || !/^[!-~]{5,32}$/m.test(password)
        ) {
            res.writeHead(303, { "Location": "/signup?error=0&username=" + encodeURIComponent(username ?? "") });
            res.write("Invalid username or password");
            res.end();
            return;
        }
        if (await DB.User.fromUsername(username) !== undefined) {
            res.writeHead(303, { "Location": "/signup?error=1&username=" + encodeURIComponent(username ?? "") });
            res.write("User with same name already exists");
            res.end();
            return;
        }
        const hashedPassword = await DB.generatePasswordHash(password);
        let user = await new DB.User(username, hashedPassword).writeChanges();
        const sessionToken = (await DB.Session.createSession(user, 3600000)).sessionId;

        await DB.Logs.info(user, "Account created from {}", ip);

        res.writeHead(303, { "Location": "/profile", "Set-Cookie": `Authorization=${encodeURIComponent(sessionToken)}; SameSite=Strict; Secure; HttpOnly; Expires=${new Date(Date.now() + 3600000).toUTCString()}` });
        res.write("Account successfully created");
        res.end();
        return;
    }

    if (url.pathname === "/login" && !authorized) {
        const [username, password] = [arg("username"), arg("password")];
        if (username === undefined || password === undefined) {
            res.writeHead(303, { "Location": "/login?error=0&username=" + encodeURIComponent(username ?? "") });
            res.end();
            return;
        }
        const user = await DB.User.fromUsername(username);
        if (user === undefined) {
            res.writeHead(303, { "Location": "/login?error=0&username=" + encodeURIComponent(username ?? "") });
            res.end();
            return;
        }
        const passwordHash = user.password;
        const correctPassword = await DB.checkPasswordHash(password, passwordHash);
        if (!correctPassword) {
            res.writeHead(303, { "Location": "/login?error=0&username=" + encodeURIComponent(username ?? "") });
            res.end();
            return;
        }

        const sessionToken = (await DB.Session.createSession(user, 3600000)).sessionId;

        await DB.Logs.info(user, "Login from {}", ip);

        res.writeHead(303, { "Location": "/profile", "Set-Cookie": `Authorization=${encodeURIComponent(sessionToken)}; SameSite=Strict; Secure; HttpOnly; Expires=${new Date(Date.now() + 3600000).toUTCString()}` });
        res.write("Sign in successful!");
        res.end();
        return;
    }

    if (url.pathname === "/upload" && authorized) {
        if (user === undefined) throw "User is authorized but user does not exist (what?)";
        if (user.permissionLevel < 1 && await user.getFileCount() >= 255) {
            res.writeHead(303, { "Location": "/upload" });
            res.write("Exceeded file limit");
            res.end();
            return;
        }
        const uploadedFile = files["uploadFile"];
        if (uploadedFile === undefined || uploadedFile.length !== 1) {
            res.writeHead(303, { "Location": "/upload" });
            res.write("Must provide 1 file");
            res.end();
            return;
        }
        const file = uploadedFile[0];

        if (file.size > 1000000000) {
            req.socket.destroy();
            return;
        }

        const suffix = (mime.getType(file.originalFilename ?? "") === "image/gif") ? ".gif" : "";
        const fileId = await DB.UserFile.generateFileId();
        res.writeHead(303, { "Location": /*`/file/${user.userid}/${fileId}`*/ `/postupload?userid=${encodeURIComponent(user.userId)}&fileid=${encodeURIComponent(fileId)}${suffix}` });
        res.write("Uploading...");
        res.end();
        /* Write file to disk, this will be changed later */
        await DB.writeUserFile(
            fileId,
            user.userId,
            file.filepath
        );
        /* Save file meta to database */
        const userFile = new DB.UserFile(
            fileId,
            user.userId,
            file.originalFilename
            ?? "unknown",
            file.mimetype
            || mime.getType(
                file.originalFilename
                ?? ""
            ),
            [],
            file.size,
            file.originalFilename ?? "no title",
            "",
            (arg("public") === "on" ? 1 : 0),
            null
        );
        await userFile.writeChanges();

        await DB.Logs.info(user, "File '{}' uploaded from {}", file.originalFilename ?? "null", ip);

        return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.write("Unknown endpoint for POST request and current state");
    res.end();
}