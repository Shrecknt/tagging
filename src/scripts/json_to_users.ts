import { useClient } from "../database";
import { User } from "../database/user";
import fs from "node:fs/promises";

async function main() {
    const client = await useClient();
    const users = (JSON.parse((await fs.readFile("users.json")).toString()) as any[]).map(User.fromObject);
    await client.query("DELETE FROM users;");
    for (let user of users) {
        await user.writeChanges();
    }
}
main().then(() => {
    console.log("Done.");
    process.exit(0);
}).catch(console.error);