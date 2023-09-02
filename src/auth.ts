import bcrypt from "bcrypt";
import { User } from "./database";

const saltRounds = 10;
export async function generatePasswordHash(password: string) {
    return await bcrypt.hash(password, saltRounds);
}
export async function checkPasswordHash(password: string, passwordHash: string) {
    return await bcrypt.compare(password, passwordHash);
}

type AccessToken = { expires: number, user: User };
const accessTokens: { [key: string]: AccessToken | undefined } = {};

export async function checkAuthorization(token: string | undefined): Promise<[false, undefined | User] | [true, User]> {
    if (token === undefined) return [false, undefined];
    if (token.includes("\n")) return [false, undefined];
    if (!/[a-zA-Z0-9]{128}/m.test(token)) return [false, undefined];
    const accessToken = accessTokens[token];
    if (accessToken === undefined) return [false, undefined];
    const user = await User.fromUserId(accessToken.user.userId);
    if (user === undefined) throw new Error("Access token found but not user (what?)");
    if (accessToken.expires < Date.now()) {
        delete accessTokens[token];
        return [false, user];
    }
    return [true, user];
}

const accessTokenChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export function createSession(user: User, expiresIn: number) {
    if (user === undefined) throw new Error("Unknown user");
    let sessionToken = "";
    do {
        sessionToken = Array.from(Array(128), () => accessTokenChars[Math.floor(Math.random() * accessTokenChars.length)]).join("");
    } while (Object.keys(accessTokens).includes(sessionToken));
    const newSession = {
        expires: Date.now() + expiresIn,
        user: user
    } as AccessToken;
    accessTokens[sessionToken] = newSession;
    return sessionToken;
}

setInterval(() => {
    for (let session in accessTokens) {
        if ((accessTokens[session]?.expires ?? 0) < Date.now()) {
            delete accessTokens[session];
        }
    }
}, 60000);