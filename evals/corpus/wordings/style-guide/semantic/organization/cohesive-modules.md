---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
---
## Package size

When something is conceptually distinct,
giving it its own small package can make it easier to use.

Go style is flexible about file size, because maintainers can move code within a
package from one file to another without affecting callers. But as a general
guideline: it is usually not a good idea to have a single file with many
thousands of lines in it, or having many tiny files. There is no "one type, one
file" convention as in some other languages. As a rule of thumb, files should be
focused enough that a maintainer can tell which file contains something, and the
files should be small enough that it will be easy to find once there. The
standard library often splits large packages to several source files, grouping
related code by file. The source for [package `bytes`] is a good example.
