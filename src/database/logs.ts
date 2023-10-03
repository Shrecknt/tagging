import { User, useClient } from "../database";

export class Logs {
    static async log_generic(user: User | null, logType: string, message: string, ...template: string[]): Promise<void> {
        const client = await useClient();

        let i = 0;
        const templatedMessage = message.replace(/\{\}/g, () => {
            if (i >= template.length) return "{}";
            return template[i++];
        });

        await client.query(`
            INSERT INTO logs
                VALUES ($1::BIGINT, $2::TEXT, $3::TEXT, $4::TEXT);
        `, [ Date.now(), user?.userId ?? null, logType, templatedMessage ]);
    }

    public static info(user: User | null, message: string, ...template: string[]) {
        return this.log_generic(user, "info", message, ...template);
    }

    public static alert(user: User | null, message: string, ...template: string[]) {
        return this.log_generic(user, "alert", message, ...template);
    }

    public static error(user: User | null, message: string, ...template: string[]) {
        return this.log_generic(user, "error", message, ...template);
    }
}