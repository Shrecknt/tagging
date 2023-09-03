import { useClient, users, setUsers, UserFile } from "../database";

export class User {
    userId: string;
    username: string;
    password: string;
    ips: Set<string>;
    frozen: boolean;
    permissionLevel: number;

    constructor(username: string, password: string, userId?: string, ips?: Set<string> | string[], frozen?: boolean, permissionLevel?: number) {
        this.username = username;
        this.password = password;
        this.userId = userId ?? User.generateUserId();
        if (ips instanceof Set) {
            this.ips = ips;
        } else if (ips instanceof Array) {
            this.ips = new Set(ips);
        } else {
            this.ips = new Set([]);
        }
        this.frozen = frozen ?? false;
        this.permissionLevel = permissionLevel ?? 0;
    }

    async writeChanges(): Promise<User> {
        const client = await useClient();
        const res = await client.query(`
            INSERT INTO users
                VALUES ($1::TEXT, $2::TEXT, $3::TEXT, $4::TEXT[], $5::BOOLEAN, $6::INT)
                ON CONFLICT (userId) DO UPDATE SET (userId, username, password, ips, frozen, permissionLevel)
                    = (excluded.userId, excluded.username, excluded.password, excluded.ips, excluded.frozen, excluded.permissionLevel);
        `, [this.userId, this.username, this.password, [...this.ips], this.frozen, this.permissionLevel]);
        return this;
    }

    async getFiles(_tags: string[] | Set<string> = [], page: number = 0, pageSize = 8): Promise<UserFile[]> {
        return UserFile.fromUserId(this.userId, _tags, page, pageSize);
    }

    async getFileCount(): Promise<number> {
        const client = await useClient();
        const res = await client.query(`
            SELECT COUNT(*) FROM files
                WHERE userid = $1::TEXT;
        `, [ this.userId ]);
        if (res.rowCount !== 1) throw new Error("Error getting count");
        const row = res.rows[0];
        return row.count;
    }

    toObject() {
        return {
            userid: this.userId,
            username: this.username,
            password: this.password,
            ips: [...this.ips],
            frozen: this.frozen,
            permissionlevel: this.permissionLevel
        };
    }

    static fromObject(obj: {
        userid?: string,
        userId?: string,
        username: string,
        password: string,
        ips: string[],
        frozen: boolean,
        permissionlevel?: number,
        permissionLevel?: number
    }) {
        return new User(
            obj.username,
            obj.password,
            obj.userid ?? obj.userId,
            obj.ips,
            obj.frozen,
            obj.permissionlevel ?? obj.permissionLevel
        );
    }

    static generateUserId() {
        const userIdChars = "0123456789";
        let userId = "";
        do {
            userId = Array.from(Array(32), () => userIdChars[Math.floor(Math.random() * userIdChars.length)]).join("");
        } while (Object.keys(users).includes(userId));
        return userId;
    }

    static async fromUserId(userId: string) {
        const client = await useClient();
        const res = await client.query("SELECT * FROM users WHERE userId = $1::TEXT;", [ userId ]);
        if (res.rowCount > 1) throw new Error("Found more than one user with given user ID (what?)");
        if (res.rowCount < 1) return undefined;
        const user = User.fromObject(res.rows[0]);
        users[user.userId] = user;
        return user;
    }

    static async fromUsername(username: string) {
        const client = await useClient();
        const res = await client.query("SELECT * FROM users WHERE username ILIKE $1::TEXT;", [ username ]);
        if (res.rowCount > 1) throw new Error("Found more than one user with given username (what?)");
        if (res.rowCount < 1) return undefined;
        const user = User.fromObject(res.rows[0]);
        users[user.userId] = user;
        return user;
    }

    static async fromUserIp(ip: string) {
        const client = await useClient();
        const res = await client.query("SELECT * FROM users WHERE $1::TEXT = ANY(ips);", [ ip ]);
        const users = res.rows.map(User.fromObject);
        return users;
    }

    static async updateUsers() {
        const client = await useClient();
        const res = await client.query("SELECT * FROM users;");
        const resUsers = res.rows.map(User.fromObject);
        setUsers(resUsers.reduce((a, b) => {
            a[b.userId] = b;
            return a;
        }, {} as {[key: string]: User | undefined}));
    }

    static async getUsers() {
        const client = await useClient();
        const res = await client.query("SELECT * FROM users;");
        const resUsers = res.rows.map(User.fromObject);
        return resUsers;
    }
};