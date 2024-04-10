import { html, render } from "https://unpkg.com/lit-html@3.1.0/lit-html.js";
import dayjs from "https://unpkg.com/dayjs@1.11.10/esm/index.js";
import utc from "https://unpkg.com/dayjs@1.11.10/esm/plugin/utc/index.js"

dayjs.extend(utc);

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
                    if (id.startsWith("logs-")){
                        const logs = {};
                        if (results?.length && results[0]?.columns?.length && results[0]?.values?.length){
                            const mixedResults = results[0];
                            for (const row of mixedResults.values){
                                const log = {
                                    branch: "",
                                    category: "",
                                    env: "",
                                    file: "",
                                    function: "",
                                    level: "",
                                    line: 0,
                                    message: "",
                                    timestamp: "",
                                    uid: "",
                                    custom: {},
                                };
                                for (let i = 0; i < mixedResults.columns.length; i++){
                                    if (mixedResults.columns[i] in log){
                                        log[mixedResults.columns[i]] = row[i];
                                    } else if (mixedResults.columns[i] === "key" && row[i] !== null) {
                                        log.custom[row[i]] = row[i + 1];
                                    }
                                }
                                logs[log.uid] = log;
                            }
                        }
                        const records = Object.values(logs) ?? [];
                        console.log("SQL: query resolved", this.queries[id].sql, this.queries[id].params, records);
                        this.queries[id].resolve(records);
                    } else {
                        const records = [];
                        if (results?.length && results[0]?.columns?.length && results[0]?.values?.length){
                            const mixedResults = results[0];
                            for (const row of mixedResults.values){
                                const record = {};
                                for (let i = 0; i < mixedResults.columns.length; i++){
                                    record[mixedResults.columns[i]] = row[i];
                                }
                                records.push(record);
                            }
                        }
                        console.log("SQL: query resolved", this.queries[id].sql, this.queries[id].params, records);
                        this.queries[id].resolve(records);
                    }
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
                uid TEXT PRIMARY KEY
            );
            CREATE TABLE custom (
                logId TEXT,
                key TEXT,
                value TEXT
            );
        `);
        customElements.define("table-component", TableComponent);
        customElements.define("table-column-editor", TableColumnEditor);
    }

    send(sql, params = {}) {this.id++;
        return new Promise((resolve, reject) => {
            const id = `query-${this.id++}`;
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

    queryLogs(sql, params = {}) {
        return new Promise((resolve, reject) => {
            const id = `logs-${this.id++}`;
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
            const promises = [];
            try {
                worker.onmessage = async (e) => {
                    const { result, type } = e.data;
                    switch (type) {
                        case "result":
                            promises.push(sql.send(`
                                INSERT INTO logs (branch, category, env, file, function, level, line, message, timestamp, uid) 
                                VALUES ($branch, $category, $env, $file, $function, $level, $line, $message, $timestamp, $uid)
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
                            }));
                            for (const key in result.custom){
                                promises.push(sql.send(`
                                    INSERT INTO custom (logId, key, value) 
                                    VALUES ($logId, $key, $value)
                                `, {
                                    "$logId": result.uid,
                                    "$key": key,
                                    "$value": result.custom[key],
                                }));
                            }
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
        this.timezone = localStorage.getItem("timezone") || "UTC";
    }
    connectedCallback(){
        this.columnsEl = document.body.querySelector("table-column-editor");
        window.addEventListener("file-selected", async (e) => {
            if (this.loading) return;
            this.loading = true;
            await parser.ingest(`/logs/${e.detail.app}/${e.detail.file}`);
            this.loading = false;
            document.title = `${e.detail.file}.log · ${e.detail.app} · Lumberjack`;
            window.dispatchEvent(new CustomEvent("file-loaded", {
                detail: e.detail,
            }));
            this.render();
        });
        window.addEventListener("timezone-changed", (e) => {
            this.timezone = e.detail.timezone;
            this.render();
        });
        window.addEventListener("columns-changed", () => {
            this.render();
        });
        this.render();
    }

    renderRow(log, columns){
        let timestamp;
        if (this.timezone == "local"){
            timestamp = dayjs(log.timestamp).local().format("YYYY-MM-DD HH:mm:ss");
        } else {
            timestamp = dayjs(log.timestamp).utc().format("YYYY-MM-DD HH:mm:ss");
        }
        return html`
            <tr>
                ${columns.map(column => {
                    if (!column.show) return "";
                    if (column.col === "level"){
                        return html`
                            <td col="level" level="${log.level.toLowerCase()}">
                                <div flex="row nowrap items-center">
                                    <svg xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="currentColor"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 2c5.523 0 10 4.477 10 10a10 10 0 0 1 -19.995 .324l-.005 -.324l.004 -.28c.148 -5.393 4.566 -9.72 9.996 -9.72zm0 9h-1l-.117 .007a1 1 0 0 0 0 1.986l.117 .007v3l.007 .117a1 1 0 0 0 .876 .876l.117 .007h1l.117 -.007a1 1 0 0 0 .876 -.876l.007 -.117l-.007 -.117a1 1 0 0 0 -.764 -.857l-.112 -.02l-.117 -.006v-3l-.007 -.117a1 1 0 0 0 -.876 -.876l-.117 -.007zm.01 -3l-.127 .007a1 1 0 0 0 0 1.986l.117 .007l.127 -.007a1 1 0 0 0 0 -1.986l-.117 -.007z" /></svg>
                                    <span>${log.level}</span>
                                </div>
                            </td>
                        `;
                    } else if (column.col === "message") {
                        return html`
                            <td col="${column.col}">${log[column.col].substring(0, 100).trim()}${log[column.col].length > 100 ? '...' : ''}</td>
                        `;
                    } else if (column.col in log) {
                        return html`
                            <td col="${column.col}">${log[column.col]}</td>
                        `;
                    } else if (column.col in log.custom) {
                        return html`
                            <td col="${column.col}">${log.custom[column.col]}</td>
                        `;
                    }
                    return html`
                        <td col="${column.col}"></td>
                    `;
                })}
            </tr>
        `;
    }

    async render(){
        const logs = await sql.queryLogs(`
            SELECT l.*, c.key, c.value
            FROM logs l
            FULL OUTER JOIN custom c ON l.uid = c.logId
            ORDER BY l.timestamp DESC 
            LIMIT ${this.page * this.pageSize}, ${this.pageSize}
        `) ?? [];
        const total = await sql.send("SELECT COUNT(*) as total FROM logs")?.[0]?.total ?? 0;
        const columns = await this.columnsEl.getColumns() ?? [];
        const view = html`
            <table>
                <thead>
                    <tr>
                        ${columns.map(column => {
                            if (!column.show) return "";
                            return html`
                                <th>${column.col}</th>
                            `;
                        })}
                    </tr>
                </thead>
                <tbody>
                    ${logs.map(log => this.renderRow(log, columns))}
                </tbody>
            </table>
        `;
        render(view, this);
        window.dispatchEvent(new CustomEvent("table-rendered", { detail: { page: this.page, total: total, logs: logs.length } }));
    }
}

class TableColumnEditor extends HTMLElement {
    constructor(){
        super();
        this.columns = [];
        this.app = "";
        this.file = "";
    }

    connectedCallback(){
        window.addEventListener("file-loaded", async (e) => {
            this.app = e.detail.app;
            this.file = e.detail.file;
            this.render();
        });
    }

    async getColumns(){
        let cachedColumns = localStorage.getItem(`${this.app}-${this.file}-columns`) || "[]";
        cachedColumns = JSON.parse(cachedColumns);
        let columns = await sql.send("SELECT * FROM logs LIMIT 1");
        if (columns.length){
            columns = Object.keys(columns[0]);
        }
        if (!columns.length) return;
        let customColumns = await sql.send("SELECT DISTINCT key FROM custom");
        for (let i = 0; i < customColumns.length; i++){
            columns.push(customColumns[i].key);
        }
        for (let i = 0; i < columns.length; i++){
            const index = cachedColumns.findIndex(col => col.col === columns[i]);
            if (index === -1) {
                cachedColumns.push({
                    col: columns[i],
                    show: true,
                });
            }
        }
        this.columns = cachedColumns;
        localStorage.setItem(`${this.app}-${this.file}-columns`, JSON.stringify(this.columns));
        return cachedColumns;
    }

    handleChange = (e) => {
        const column = e.target.name;
        const show = e.target.checked;
        const index = this.columns.findIndex(col => col.col === column);
        this.columns[index].show = show;
        localStorage.setItem(`${this.app}-${this.file}-columns`, JSON.stringify(this.columns));
        this.render();
        window.dispatchEvent(new CustomEvent("columns-changed"));
    }

    async render(){
        if (!this.app || !this.file) return;
        await this.getColumns();
        const view = html`
            <label>Columns</label>
            <ul>
                ${this.columns.map(column => html`
                    <li>
                        <svg  xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M18 9l3 3l-3 3" /><path d="M15 12h6" /><path d="M6 9l-3 3l3 3" /><path d="M3 12h6" /><path d="M9 18l3 3l3 -3" /><path d="M12 15v6" /><path d="M15 6l-3 -3l-3 3" /><path d="M12 3v6" /></svg>
                        <input @change=${this.handleChange} type="checkbox" id="${column.col}" name="${column.col}" ?checked=${column.show}>
                        <label for="${column.col}">${column.col}</label>
                    </li>
                `)}
            </ul>
        `;
        render(view, this);
        new Sortable(this.querySelector("ul"), {
            animation: 150,
            handle: 'svg',
            onUpdate: (e) => {
                this.columns = Array.from(this.querySelectorAll("li")).map((li, i) => {
                    return {
                        col: li.querySelector("input").name,
                        show: li.querySelector("input").checked,
                    };
                });
                localStorage.setItem(`${this.app}-${this.file}-columns`, JSON.stringify(this.columns));
                window.dispatchEvent(new CustomEvent("columns-changed"));
            }
        });
    }
}
