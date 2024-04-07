<p align="center">
  <img alt="lumberjack - a free and open source log aggregator" src="https://github.com/codewithkyle/lumberjack/assets/15202776/038998b3-183b-43db-98fb-bd6ec4e02f18">
</p>

## Design

| Dark | Light |
| - | - |
| ![Preview Dark Mode](https://github.com/codewithkyle/lumberjack/assets/15202776/5cac38c7-a36f-40e6-94af-360e20d35bc8) | ![Preview Light Mode](https://github.com/codewithkyle/lumberjack/assets/15202776/2ae9cbc5-8bc3-4aec-8ec8-796a2bf745f4) |

## Schema

#### Example 1

```
[Informational] - 2024-04-06T08:48:24Z
Branch: 7c96197c-6ecb-4b3b-885a-d4ee97fe87e9
Category: Example
Custom Key: hi mom!
Message:
This is the an example message.
It can span many lines.
---[EOL]--
```

#### Example 2

```
[Error] - 2024-04-06T08:48:24Z
Branch: 7c96197c-6ecb-4b3b-885a-d4ee97fe87e9
Category: Example
File: /home/codewithkyle/my-app/services/DatabaseService.php
Function: query()
Line: 69
Message:
This is the an example message.
It can span many lines.
---[EOL]--
```

A log must always begin with the [log serverity](https://datatracker.ietf.org/doc/html/rfc5424) name contained within a pair of `[]` followed by a [ISO 8601](https://en.wikipedia.org/wiki/ISO_8601) UTC timestamp seperated by a `-`.

All of the following values are optional. If none of the optional values exist within a log entry the log will be discarded and ignored.

`Branch`

An integer, string, or UUID (prefered). This value will be parsed and stored as a string. It will be used to link several log entries together and can be useful for tracking the execution of a code path through a system.

---

`Category`

Any string value. It will be used for filtering logs within the admin web portal.

---

`File`

Any string value. This value should be the file that triggered the debug or error.

---

`Function`

Any string value. This value should be the name of the function that triggered the debug or error.

---

`Line`

Any integer or string value. This value should be the line number that triggered the debug or error.

---

`Message`

The message can contain any data type and may span multiple lines. Anything written within the lines will be parsed and stored as a string. The message parser will continue to parse and append new lines to the log entry message until the `---[EOL]--` marker is reached. The message must always appear last within a log entry.

---

Lumberjack also supports custom data definitions. Custom data is limited to one line. It must start with a key followed immediately by a `:` symbol. The key and the data will both be parsed and stored as strings. The custom keys will be toggleable within the admin portal data table settings and will be hidden by default.

## Shipping Log Files

Log files can be easily sent to the Lumberjack service from any machine that has find, cURL, and bash installed using the following command:

```bash
find /path/to/app/logs -type f -name "*.log" -exec bash -c 'curl -X POST -H "Lumberjack-App: My App" -H "Lumberjack-Env: Dev" --data-binary @{} http://example.com && [[ $? -eq 0 ]] && rm -f "{}"' \;
```

Within the cURL request the URL will need to be replaced with the URL of your Lumberjack server.

The `Lumberjack-App` header will need to be changed to the name of the application that is creating the logs.

The `Lumberjack-Env` header will need to be updated to the environment your application is running in. It can be any string value and will be used for filtering logs within the admin web portal.

> We recommend configuring the log shipping command as a cron job to automatically ship new logs at 5 minute intervals.
