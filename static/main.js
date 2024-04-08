class SQL {
    constructor() {
        this.db = null;
        this.id = 1;
        this.queries = {};
        this.init();
    }

    async init() {
        this.db = new Worker("/static/worker.sql-wasm.js");
        this.db.onmessage = () => {
            console.log("SQL: database opened");
            this.db.onmessage = event => {
                const { id, results } = event.data;
                if (id in this.queries){
                    this.queries[id].resolve(results);
                    delete this.queries[id];
                }
            };

            this.createTables();
        };
        this.db.onerror = e => console.log("Worker error: ", e);
        this.db.postMessage({
            id:1,
            action:"open",
        });
    }

    async createTables() {
        await this.send(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL,
                password TEXT NOT NULL
            )
        `);
        console.log("SQL: tables created");
    }

    send(sql, params = {}) {
        return new Promise((resolve, reject) => {
            const id = this.id++;
            this.queries[id] = { resolve, reject, sql, params };
            this.db.postMessage({
                id: id,
                action: "exec",
                sql: sql.replace(/\n/g, "").trim(),
                params: params
            });
        });
    }
}
const sql = new SQL();
