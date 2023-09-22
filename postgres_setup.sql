DROP TABLE IF EXISTS usessions;
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
	userId TEXT NOT NULL,
	username TEXT NOT NULL,
	password TEXT NOT NULL,
	ips TEXT ARRAY NOT NULL,
	frozen BOOLEAN NOT NULL,
	permissionLevel INT NOT NULL,
	UNIQUE (userId)
);

CREATE TABLE files (
	fileId TEXT NOT NULL,
	userId TEXT NOT NULL,
	PRIMARY KEY (fileId),
	CONSTRAINT fk_user
		FOREIGN KEY(userId) 
		REFERENCES users(userId),
	fileName TEXT NOT NULL,
	mimeType TEXT,
	tags TEXT[] NOT NULL,
	fileSize BIGINT NOT NULL,
	title TEXT NOT NULL,
	description TEXT NOT NULL,
	visibility INT NOT NULL,
	shortUrl TEXT,
	UNIQUE (fileId)
);

CREATE TABLE usessions (
    sessionId TEXT NOT NULL,
    userId TEXT NOT NULL,
	PRIMARY KEY (sessionId),
	CONSTRAINT fk_user
		FOREIGN KEY(userId) 
		REFERENCES users(userId),
    expires BIGINT NOT NULL
);
