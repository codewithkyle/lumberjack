import { html, render } from "https://unpkg.com/lit-html@3.1.0/lit-html.js";

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
                    const records = [];
                    if (results?.length && results[0]?.columns?.length && results[0]?.values?.length){
                        const mixedResults = results[0];
                        for (const row of mixedResults.values){
                            const record = {};
                            for (let i = 0; i < mixedResults.columns.length; i++){
                                if (mixedResults.columns[i] === "custom"){
                                    record[mixedResults.columns[i]] = JSON.parse(row[i]);
                                } else {
                                    record[mixedResults.columns[i]] = row[i];
                                }
                            }
                            records.push(record);
                        }
                    }
                    console.log("SQL: query resolved", this.queries[id].sql, this.queries[id].params, records);
                    this.queries[id].resolve(records);
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
            CREATE TABLE logs (
                branch TEXT,
                category TEXT,
                env TEXT,
                file TEXT,
                function TEXT,
                level TEXT,
                line INTEGER,
                message TEXT,
                timestamp TEXT,
                uid TEXT PRIMARY KEY,
                custom TEXT
            );
        `);
        console.log("SQL: tables created");
    }

    send(sql, params = {}) {
        return new Promise((resolve, reject) => {
            const id = this.id++;
            sql = sql.replace(/\n/g, "").replace(/\s+/g, " ").trim();
            this.queries[id] = { resolve, reject, sql, params };
            this.db.postMessage({
                id: id,
                action: "exec",
                sql: sql,
                params: params
            });
        });
    }
}
const sql = new SQL();

class LogParser {
    ingest(file) {
        return new Promise(async (resolve, reject) => {
            const worker = new Worker("/static/worker.log-parser.js");
            console.log("Worker created");
            const promises = [];
            try {
                worker.onmessage = async (e) => {
                    const { result, type } = e.data;
                    switch (type) {
                        case "result":
                            console.log(result);
                            promises.push(sql.send(`
                                INSERT INTO logs (branch, category, env, file, function, level, line, message, timestamp, uid, custom) 
                                VALUES ($branch, $category, $env, $file, $function, $level, $line, $message, $timestamp, $uid, $custom)
                            `, {
                                "$branch": result.branch,
                                "$category": result.category,
                                "$env": result.env,
                                "$file": result.file,
                                "$function": result.function,
                                "$level": result.level,
                                "$line": result.line,
                                "$message": result.message,
                                "$timestamp": result.timestamp,
                                "$uid": result.uid,
                                "$custom": JSON.stringify(result.custom),
                            }));
                            break;
                        case "done":
                            worker.terminate();
                            await Promise.all(promises);
                            resolve();
                            break;
                        default:
                            break;
                    }
                };
                worker.postMessage({
                    url: file,
                    args: {},
                });
            } catch (e) {
                console.error(e);
                worker.terminate();
                reject(e);
            }
        });
    }
}
const parser = new LogParser();

class TableComponent extends HTMLElement{
    constructor(){
        super();
        this.loading = false;
        this.page = 0;
        this.pageSize = 100;
    }
    connectedCallback(){
        window.addEventListener("file-selected", async (e) => {
            if (this.loading) return;
            this.loading = true;
            await parser.ingest(`/logs/${e.detail.app}/${e.detail.file}.jsonl`);
            this.loading = false;
            this.render();
        });
        this.render();
    }

    renderRow(log){
        console.log(log);
        return html`
            <tr>
                <td col="level" level="${log.level.toLowerCase()}">
                    <div flex="row nowrap items-center">
                        <svg xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="currentColor"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 2c5.523 0 10 4.477 10 10a10 10 0 0 1 -19.995 .324l-.005 -.324l.004 -.28c.148 -5.393 4.566 -9.72 9.996 -9.72zm0 9h-1l-.117 .007a1 1 0 0 0 0 1.986l.117 .007v3l.007 .117a1 1 0 0 0 .876 .876l.117 .007h1l.117 -.007a1 1 0 0 0 .876 -.876l.007 -.117l-.007 -.117a1 1 0 0 0 -.764 -.857l-.112 -.02l-.117 -.006v-3l-.007 -.117a1 1 0 0 0 -.876 -.876l-.117 -.007zm.01 -3l-.127 .007a1 1 0 0 0 0 1.986l.117 .007l.127 -.007a1 1 0 0 0 0 -1.986l-.117 -.007z" /></svg>
                        <span>${log.level}</span>
                    </div>
                </td>
                <td col="timestamp">${dayjs(log.timestamp).format("YYYY-MM-DD HH:mm:ss")}</td>
                <td col="category">${log.category}</td>
                <td col="message">${log.message}</td>
                <td col="env">${log.env}</td>
                <td col="file">${log.file}</td>
                <td col="function">${log.function}</td>
                <td col="line">${log.line}</td>
                <td col="branch">${log.branch}</td>
            </tr>
        `;
    }

    async render(){
        const logs = await sql.send(`
            SELECT * FROM logs
            ORDER BY timestamp DESC 
            LIMIT ${this.page * this.pageSize}, ${this.pageSize}
        `) ?? [];
        const total = await sql.send("SELECT COUNT(*) as total FROM logs") ?? [];
        const view = html`
            <table>
                <thead>
                    <tr>
                        <th>Level</th>
                        <th>Time</th>
                        <th>Category</th>
                        <th>Message</th>
                        <th>Env</th>
                        <th>File</th>
                        <th>Function</th>
                        <th>Line</th>
                        <th>Branch</th>
                    </tr>
                </thead>
                <tbody>
                    ${logs.map(log => this.renderRow(log))}
                </tbody>
            </table>
        `;
        render(view, this);
        window.dispatchEvent(new CustomEvent("table-rendered", { detail: { page: this.page, total: total[0].total, logs: logs.length } }));
    }
}
customElements.define("table-component", TableComponent);
