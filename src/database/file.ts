import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { User, useClient } from "../database";

export const allowedMimeTypes = fsSync.readFileSync("allowed_mime_types.txt")
    .toString()
    .replace(/\r/g, "")
    .split("\n")
    .map(type => type.trim())
    .filter(type => type !== "");

export class UserFile {
    fileId: string;
    userId: string;
    fileName: string;
    mimeType: string | null;
    tags: Set<string>;
    fileSize: BigInt;
    title: string;
    description: string;
    visibility: number;
    shortUrl: string | null;

    constructor(fileId: string, userId: string, fileName: string, mimeType: string | null, tags: Set<string> | string[], fileSize: BigInt | number, title: string, description: string, visibility: number, shortUrl: string | null) {
        this.fileId = fileId;
        this.userId = userId;
        this.fileName = fileName;
        this.mimeType = mimeType;
        this.tags = new Set((tags instanceof Set ? [...tags] : tags).map(tag => tag.toLowerCase()));
        this.visibility = visibility;
        if (fileSize instanceof BigInt) {
            this.fileSize = fileSize;
        } else {
            this.fileSize = BigInt(fileSize);
        }
        this.title = title;
        this.description = description;
        this.shortUrl = shortUrl;
    }

    async writeChanges(): Promise<UserFile> {
        const client = await useClient();
        const res = await client.query(`
            INSERT INTO files
                VALUES ($1::TEXT, $2::TEXT, $3::TEXT, $4::TEXT, $5::TEXT[], $6::BIGINT, $7::TEXT, $8::TEXT, $9::INT, $10::TEXT)
                ON CONFLICT (fileId) DO UPDATE SET (fileId, userId, fileName, mimeType, tags, fileSize, title, description, visibility, shortUrl)
                    = (excluded.fileId, excluded.userId, excluded.fileName, excluded.mimeType, excluded.tags, excluded.fileSize, excluded.title, excluded.description, excluded.visibility, excluded.shortUrl);
        `, [this.fileId, this.userId, this.fileName, this.mimeType, [...this.tags], this.fileSize, this.title, this.description, this.visibility, this.shortUrl]);
        return this;
    }

    async getUser(): Promise<User> {
        const user = await User.fromUserId(this.userId);
        if (user === undefined) throw new Error("File is not associated with an existing user");
        return user;
    }

    toObject() {
        return {
            fileid: this.fileId,
            userid: this.userId,
            filename: this.fileName,
            mimetype: this.mimeType,
            tags: [...this.tags],
            filesize: this.fileSize,
            title: this.title,
            description: this.description,
            visibility: this.visibility,
            shorturl: this.shortUrl
        };
    }

    static fromObject(obj: {
        fileId?: string,
        fileid?: string,
        userId?: string,
        userid?: string,
        fileName?: string,
        filename?: string,
        mimeType?: string,
        mimetype?: string,
        tags: string[],
        fileSize?: BigInt | number,
        filesize?: BigInt | number,
        title: string,
        description: string,
        visibility: number,
        shortUrl?: string,
        shorturl?: string
    }) {
        if (obj.fileId ?? obj.fileid === undefined) throw new Error("Must provide either `fileId` or `fileid`");
        if (obj.userId ?? obj.userid === undefined) throw new Error("Must provide either `userId` or `userid`");
        if (obj.fileName ?? obj.filename === undefined) throw new Error("Must provide either `fileName` or `filename`");
        if (obj.fileSize ?? obj.filesize === undefined) throw new Error("Must provide either `fileSize` or `filesize`");
        return new UserFile(
            obj.fileId ?? obj.fileid,
            obj.userId ?? obj.userid,
            obj.fileName ?? obj.filename,
            obj.mimeType ?? obj.mimetype ?? null,
            obj.tags,
            obj.fileSize ?? obj.filesize,
            obj.title,
            obj.description,
            obj.visibility,
            obj.shortUrl ?? obj.shorturl ?? null
        );
    }

    static async generateFileId() {
        const fileIdChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        let fileId = "";
        do {
            fileId = Array.from(Array(32), () => fileIdChars[Math.floor(Math.random() * fileIdChars.length)]).join("");
        } while (await UserFile.fromFileId(fileId) !== undefined);
        return fileId;
    }

    static async generateShortUrl() {
        const shortUrlChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        let shortUrl = "";
        do {
            shortUrl = Array.from(Array(8), () => shortUrlChars[Math.floor(Math.random() * shortUrlChars.length)]).join("");
        } while (await UserFile.fromShortUrl(shortUrl) !== undefined);
        return shortUrl;
    }

    static async fromUserId(userId: string, _tags: string[] | Set<string> = [], page: number = 0, pageSize = 8) {
        const tags = (_tags instanceof Set ? [..._tags] : _tags).map(tag => tag.toLowerCase());
        const client = await useClient();
        let query = "SELECT * FROM files WHERE userId = $1::TEXT";
        const params: any[] = [ userId ];
        let paramNumber = 2;
        if (tags.length > 0) {
            query += ` AND ARRAY(
		        SELECT UNNEST($2::TEXT[])
		        EXCEPT SELECT UNNEST(tags)
	        ) = '{}'::TEXT[]`;
            params.push(tags);
            paramNumber++;
        }
        query += ` LIMIT \$${paramNumber++}::INT OFFSET \$${paramNumber++}::INT;`;
        params.push(pageSize, page * pageSize);
        const res = await client.query(query, params);
        const files = res.rows.map(UserFile.fromObject);
        return files;
    }

    static async fromTags(_tags: string[] | Set<string> = [], page: number = 0, pageSize: number = 8, user?: User | string) {
        const userId = (user === undefined) ? undefined : ((user instanceof User) ? user.userId : user);
        const tags: string[] = (_tags instanceof Set ? [..._tags] : _tags)
            .map(tag => tag.toLowerCase())
            .filter(tag => tag !== "");
        const client = await useClient();
        let query = `
            SELECT * FROM files
            WHERE ARRAY(
		        SELECT UNNEST($1::TEXT[])
		        EXCEPT SELECT UNNEST(tags)
	        ) = '{}'::TEXT[]
        `;
        const queryArguments: any[] = [tags, pageSize, page * pageSize];
        if (userId !== undefined) {
            query += " AND NOT (userId != $4::TEXT AND visibility < 2)"
            queryArguments.push(userId);
        }
        query += " LIMIT $2::INT OFFSET $3::INT;";
        const res = await client.query(query, queryArguments);
        const files = res.rows.map(UserFile.fromObject);
        return files;
    }

    static async fromFileId(fileId: string) {
        const client = await useClient();
        const res = await client.query("SELECT * FROM files WHERE fileId = $1::TEXT;", [ fileId ]);
        if (res.rowCount > 1) throw new Error("Found more than one file with given fileId (what?)");
        if (res.rowCount < 1) return undefined;
        const file = UserFile.fromObject(res.rows[0]);
        return file;
    }

    static async fromShortUrl(shortUrl: string) {
        const client = await useClient();
        const res = await client.query("SELECT * FROM files WHERE shortUrl = $1::TEXT;", [ shortUrl ]);
        if (res.rowCount > 1) throw new Error("Found more than one file with given shortUrl (what?)");
        if (res.rowCount < 1) return undefined;
        const file = UserFile.fromObject(res.rows[0]);
        return file;
    }
};

export async function writeUserFile(fileId: string, userid: string, filePath: string) {
    const userFilesDir = path.join(process.env["STORAGE_DIRECTORY"] ?? "user_files/", userid);
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
