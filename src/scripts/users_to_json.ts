import { User } from "../database/user";
import fs from "node:fs/promises";

async function main() {
    const users = (await User.getUsers()).map(user => user.toObject());
    await fs.writeFile("users.json", JSON.stringify(users, null, 4));
}
main().then(() => {
    console.log("Done.");
    process.exit(0);
}).catch(console.error);