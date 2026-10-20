---
globs: ["**/*.py"]
---
# Don't swallow exceptions

Do not use a bare `except:`. Do not catch `Exception` or `BaseException` unless the handler re-raises or logs the exception. Catching a specific exception type is fine, whatever the handler does.
