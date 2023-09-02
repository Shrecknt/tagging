import fs from "node:fs";
import { useClient } from "../database";

export const allowedMimeTypes = fs.readFileSync("allowed_mime_types.txt")
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

    constructor(fileId: string, userId: string, fileName: string, mimeType: string | null, tags: Set<string> | string[], _public: boolean, fileSize: BigInt | number) {
        this.fileId = fileId;
        this.userId = userId;
        this.fileName = fileName;
        this.mimeType = mimeType;
        if (tags instanceof Set) {
            this.tags = tags;
        } else {
            this.tags = new Set(tags);
        }
        this._public = _public;
        if (fileSize instanceof BigInt) {
            this.fileSize = fileSize;
        } else {
            this.fileSize = BigInt(fileSize);
        }
    }

    async writeChanges(): Promise<UserFile> {
        const client = await useClient();
        const res = await client.query(`INSERT INTO files
	        VALUES ($1::TEXT, $2::TEXT, $3::TEXT, $4::TEXT, $5::TEXT[], $6::BOOL, $7::BIGINT)
	        ON CONFLICT (fileId) DO UPDATE SET (fileId, userId, fileName, mimeType, tags, _public, fileSize)
		        = (excluded.fileId, excluded.userId, excluded.fileName, excluded.mimeType, excluded.tags, excluded._public, excluded.fileSize);`,
                [this.fileId, this.userId, this.fileName, this.mimeType, [...this.tags], this._public, this.fileSize]);
        return this;
    }

    toObject() {
        return {
            fileid: this.fileId,
            userid: this.userId,
            filename: this.fileName,
            mimetype: this.mimeType,
            filesize: this.fileSize
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
        filesize?: BigInt | number
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
            obj.fileSize ?? obj.filesize
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
        const tags = _tags instanceof Set ? _tags : new Set(_tags);
        const client = await useClient();
        let query = "SELECT * FROM files WHERE userId = $1::TEXT";
        const params: any[] = [ userId ];
        if (tags.size > 0) {
            query += ` AND ARRAY(
		        SELECT UNNEST($2::TEXT[])
		        EXCEPT SELECT UNNEST(tags)
	        ) = '{}'::TEXT[]`;
            params.push([...tags]);
        }
        const res = await client.query(query, params);
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