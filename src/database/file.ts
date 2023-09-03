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
    _public: boolean;
    fileSize: BigInt;
    title: string;
    description: string;

    constructor(fileId: string, userId: string, fileName: string, mimeType: string | null, tags: Set<string> | string[], _public: boolean, fileSize: BigInt | number, title: string, description: string) {
        this.fileId = fileId;
        this.userId = userId;
        this.fileName = fileName;
        this.mimeType = mimeType;
        this.tags = new Set((tags instanceof Set ? [...tags] : tags).map(tag => tag.toLowerCase()));
        this._public = _public;
        if (fileSize instanceof BigInt) {
            this.fileSize = fileSize;
        } else {
            this.fileSize = BigInt(fileSize);
        }
        this.title = title;
        this.description = description;
    }

    async writeChanges(): Promise<UserFile> {
        const client = await useClient();
        const res = await client.query(`
            INSERT INTO files
                VALUES ($1::TEXT, $2::TEXT, $3::TEXT, $4::TEXT, $5::TEXT[], $6::BOOL, $7::BIGINT, $8::TEXT, $9::TEXT)
                ON CONFLICT (fileId) DO UPDATE SET (fileId, userId, fileName, mimeType, tags, _public, fileSize, title, description)
                    = (excluded.fileId, excluded.userId, excluded.fileName, excluded.mimeType, excluded.tags, excluded._public, excluded.fileSize, excluded.title, excluded.description);
        `, [this.fileId, this.userId, this.fileName, this.mimeType, [...this.tags], this._public, this.fileSize, this.title, this.description]);
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
            public: this._public,
            filesize: this.fileSize,
            title: this.title,
            description: this.description
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
        public?: boolean,
        _public?: boolean,
        fileSize?: BigInt | number,
        filesize?: BigInt | number,
        title: string,
        description: string
    }) {
        if (obj.fileId ?? obj.fileid === undefined) throw new Error("Must provide either `fileId` or `fileid`");
        if (obj.userId ?? obj.userid === undefined) throw new Error("Must provide either `userId` or `userid`");
        if (obj.fileName ?? obj.filename === undefined) throw new Error("Must provide either `fileName` or `filename`");
        if (obj.public ?? obj._public === undefined) throw new Error("Must provide either `public` or `_public`");
        if (obj.fileSize ?? obj.filesize === undefined) throw new Error("Must provide either `fileSize` or `filesize`");
        return new UserFile(
            obj.fileId ?? obj.fileid,
            obj.userId ?? obj.userid,
            obj.fileName ?? obj.filename,
            obj.mimeType ?? obj.mimetype ?? null,
            obj.tags,
            obj.public ?? obj._public,
            obj.fileSize ?? obj.filesize,
            obj.title,
            obj.description
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

    static async fromUserId(userId: string, _tags: string[] | Set<string> = []) {
        const tags = (_tags instanceof Set ? [..._tags] : _tags).map(tag => tag.toLowerCase());
        const client = await useClient();
        let query = "SELECT * FROM files WHERE userId = $1::TEXT";
        const params: any[] = [ userId ];
        if (tags.length > 0) {
            query += ` AND ARRAY(
		        SELECT UNNEST($2::TEXT[])
		        EXCEPT SELECT UNNEST(tags)
	        ) = '{}'::TEXT[]`;
            params.push(tags);
        }
        const res = await client.query(query, params);
        const files = res.rows.map(UserFile.fromObject);
        return files;
    }

    static async fromTags(_tags: string[] | Set<string> = []) {
        const tags: string[] = (_tags instanceof Set ? [..._tags] : _tags)
            .map(tag => tag.toLowerCase())
            .filter(tag => tag !== "");
        const client = await useClient();
        const res = await client.query(`
            SELECT * FROM files
            WHERE ARRAY(
		        SELECT UNNEST($1::TEXT[])
		        EXCEPT SELECT UNNEST(tags)
	        ) = '{}'::TEXT[];
        `, [ tags ]);
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
};

export async function writeUserFile(fileId: string, userid: string, filePath: string, _public: boolean) {
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
