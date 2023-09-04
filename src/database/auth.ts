import bcrypt from "bcrypt";
import { User, useClient } from "../database";

const saltRounds = 10;
export async function generatePasswordHash(password: string) {
    return await bcrypt.hash(password, saltRounds);
}
export async function checkPasswordHash(password: string, passwordHash: string) {
    return await bcrypt.compare(password, passwordHash);
}

export class Session {
    sessionId: string;
    expires: number;
    userId: string;

    constructor(sessionId: string, expires: number, user: User | string) {
        const userId = user instanceof User ? user.userId : user;
        this.sessionId = sessionId;
        this.expires = expires;
        this.userId = userId;
    }

    async writeChanges(): Promise<Session> {
        const client = await useClient();
        const res = await client.query(`
            INSERT INTO usessions
                VALUES ($1::TEXT, $2::TEXT, $3::BIGINT)
                ON CONFLICT (sessionId) DO UPDATE SET (sessionId, userId, expires)
                    = (excluded.sessionId, excluded.userId, excluded.expires);
        `, [this.sessionId, this.userId, this.expires]);
        return this;
    }

    isValid() {
        return Date.now() > this.expires;
    }

    async getUser(): Promise<User> {
        const user = await User.fromUserId(this.userId);
        if (user === undefined) throw new Error("Access token found but not user (what?)");
        return user;
    }

    async delete(): Promise<void> {
        const client = await useClient();
        const res = await client.query(`
            DELETE FROM usessions
                WHERE sessionId = $1::TEXT;
        `, [ this.sessionId ]);
    }

    toObject() {
        return {
            sessionid: this.sessionId,
            expires: this.expires,
            userid: this.userId
        };
    }

    static fromObject(obj: {
        sessionId?: string,
        sessionid?: string,
        expires: number,
        userId?: string,
        userid?: string
    }) {
        if (obj.sessionId ?? obj.sessionid === undefined) throw new Error("Must provide either `sessionId` or `sessionid`");
        if (obj.userId ?? obj.userid === undefined) throw new Error("Must provide either `userId` or `userid`");
        return new Session(
            obj.sessionId ?? obj.sessionid,
            obj.expires,
            obj.userId ?? obj.userid
        );
    }

    static async generateSessionId() {
        const accessTokenChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        let sessionId = "";
        do {
            sessionId = Array.from(Array(128), () => accessTokenChars[Math.floor(Math.random() * accessTokenChars.length)]).join("");
        } while (await Session.fromSessionId(sessionId) != undefined);
        return sessionId;
    }

    static async fromSessionId(sessionId: string): Promise<Session | undefined> {
        const client = await useClient();
        const res = await client.query(`
            SELECT * FROM usessions
                WHERE sessionId = $1::TEXT;
        `, [ sessionId ]);
        if (res.rowCount > 1) throw new Error("Found more than one session with given sessionId (what?)");
        if (res.rowCount === 0) return undefined;
        return Session.fromObject(res.rows[0]);
    }

    static async checkAuthorization(token: string | undefined): Promise<[false, undefined | User] | [true, User]> {
        if (token === undefined) return [false, undefined];
        // possibly not needed start
        if (token.includes("\n")) return [false, undefined];
        if (!/[a-zA-Z0-9]{128}/m.test(token)) return [false, undefined];
        // possibly not needed end
        const session = await Session.fromSessionId(token);
        if (session === undefined) return [false, undefined];
        const user = await session.getUser();
        if (session.expires < Date.now()) {
            await session.delete();
            return [false, user];
        }
        return [true, user];
    }

    static async createSession(user: User, expiresIn: number): Promise<Session> {
        if (user === undefined) throw new Error("Unknown user");
        const sessionId = await this.generateSessionId();
        const session = new Session(sessionId, Date.now() + expiresIn, user);
        await session.writeChanges();
        return session;
    }
}

setInterval(async () => {
    const client = await useClient();
    const expiredSessions = (await client.query(`
        SELECT * FROM usessions
            WHERE expires < $1::BIGINT;
    `, [ Date.now() ])).rows.map(Session.fromObject);
    for (let session of expiredSessions) {
        await session.delete();
    }
}, 60000);