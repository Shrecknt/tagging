import assert from "node:assert";

import { Client } from "pg";

import { User } from "./database/user"
import { UserFile } from "./database/file";

export { User } from "./database/user";
export { UserFile, writeUserFile } from "./database/file";

require("dotenv").config();

let client: Client | undefined;
export let users: {[key: string]: User | undefined} = {};
export const setUsers = (newUsers: {[key: string]: User | undefined}) => users = newUsers;

export async function useClient() {
    if (client !== undefined) return client;
    client = new Client({
        "database": "tagging",
        "user": process.env.POSTGRES_USER ?? "postgres",
        "password": process.env.POSTGRES_PASSWORD,
        "host": process.env.POSTGRES_HOST,
        "port": Number(process.env.POSTGRES_PORT ?? 5432)
    });
    await client.connect();
    return client;
}

async function main() {
    const client = await useClient();

    // await client.query("DELETE FROM users;");

    // await client.query("INSERT INTO users VALUES ($1::TEXT, $2::TEXT, $3::TEXT, $4::TEXT[], $5::BOOLEAN, $6::INT);", ["test-userid", "test-username", "test-password", ["test-ip"], false, 0]);

    // const user = new User("Shrecknt", "password");
    // await user.writeChanges();
    // user.password = "password2";
    // await user.writeChanges();

    // const res = await client.query("SELECT * FROM users;");
    // console.log("res", res);
    // console.log("res.rows", res.rows);

    const shreckntUser = await User.fromUsername("Shrecknt");
    assert(shreckntUser !== undefined);

    // console.log((await shreckntUser.getFiles()).length);
    console.log(shreckntUser.userId);
    console.log(await shreckntUser.getFileCount());
    console.log(await shreckntUser.cumulativeFileSize());

    // const newFile = new UserFile("12345", shreckntUser.userId, "test.txt", "text/plain", [ "test-tag" ], 0, "test.txt", "", 0);
    // newFile.writeChanges();

    // const searchTag = await UserFile.fromUserId(shreckntUser.userId, [ "test-tag" ]);
    // console.log("searchTag", searchTag);

    // console.log(await User.fromUserIp("test-ip") /* User[] */);
    // console.log(await User.fromUserId("test-userid") /* User | undefined */);
    // console.log(await User.fromUsername("test-username") /* User | undefined */);
}

// main();