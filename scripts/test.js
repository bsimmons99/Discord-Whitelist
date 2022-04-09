const mariadb = require('mariadb');
const debug = require('debug')('discord-whitelist:test');

async function init() {
    const connection = await mariadb.createConnection(
        {
            host: 'localhost',
            port: 3306,
            user: 'mcwhitelist',
            password: 'aDFxfntCSrcWgPPT',
            database: 'mcwhitelist',
        }
    );

    let testq = await connection.query('SELECT `time_accessed` FROM `User` WHERE `discord_id`="242935741422764033" ORDER BY `transaction_id` DESC LIMIT 1;');
    debug(typeof(testq[0].time_accessed));
    debug(typeof(new Date()));
}

init();
