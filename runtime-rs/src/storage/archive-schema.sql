-- Archive chunks are durable content, so older runtimes must reject this schema.
CREATE TABLE profile_archive_chunks(hash TEXT PRIMARY KEY,body TEXT NOT NULL,touched INTEGER NOT NULL);
