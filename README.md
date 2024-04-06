<p align="center">
  <img alt="lumberjack - a free and open source log aggregator" src="https://github.com/codewithkyle/lumberjack/assets/15202776/038998b3-183b-43db-98fb-bd6ec4e02f18">
</p>

## Design

| Dark | Light |
| - | - |
| ![Preview Dark Mode](https://github.com/codewithkyle/lumberjack/assets/15202776/5cac38c7-a36f-40e6-94af-360e20d35bc8) | ![Preview Light Mode](https://github.com/codewithkyle/lumberjack/assets/15202776/2ae9cbc5-8bc3-4aec-8ec8-796a2bf745f4) |

## Schema

#### General Example

```
[Informational] - 2024-04-06T08:48:24Z
Environment: Dev
Branch: 7c96197c-6ecb-4b3b-885a-d4ee97fe87e9
Category: Example
Message:
This is the an example message.
It can span many lines.
---[EOL]--
```

#### Error Example

```
[Error] - 2024-04-06T08:48:24Z
Environment: Dev
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

The following values are optional:

> **Note**: if none of the optional values exist within a log entry the log will be discarded and ignored.

`Environment`

Any string value. It will be used for filtering logs within the admin web portal.

---

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
