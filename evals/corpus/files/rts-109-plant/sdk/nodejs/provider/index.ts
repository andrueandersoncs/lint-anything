// Copyright 2016, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

export * from "./provider";
export * from "./server";

export function formatTimestamp(date: Date): string {
    const pad = (n: number) => n.toString().padStart(2, "0");
    return (
        `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
        `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
    );
}

export function parseDurationMs(input: string): number {
    const match = /^(\d+)(ms|s|m|h)$/.exec(input.trim());
    if (!match) {
        throw new Error(`invalid duration: ${input}`);
    }
    const value = parseInt(match[1], 10);
    switch (match[2]) {
        case "h":
            return value * 3600000;
        case "m":
            return value * 60000;
        case "s":
            return value * 1000;
        default:
            return value;
    }
}