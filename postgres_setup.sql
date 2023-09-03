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
	_public BOOLEAN NOT NULL,
	fileSize BIGINT NOT NULL,
	title TEXT NOT NULL,
	description TEXT NOT NULL,
	UNIQUE (fileId)
);


-- INSERT INTO users
-- 	VALUES ('test-userId', 'test-username', 'test-password', '{"test-ip"}', false, 0);

-- INSERT INTO users
-- 	VALUES ('test-userId', 'test-username2', 'test-password', '{"test-ip"}', false, 0)
-- 	ON CONFLICT (userId, username) DO UPDATE SET (userId, username, password, ips, frozen, permissionLevel)
-- 		= (excluded.userId, excluded.username, excluded.password, excluded.ips, excluded.frozen, excluded.permissionLevel);

SELECT * FROM users;