---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
---
# Comments

Comments that contradict the code are worse than no comments.  Always
make a priority of keeping the comments up-to-date when the code
changes!

Inline comments are unnecessary and in fact distracting if they state
the obvious.  Don't do this:

```python
x = x + 1                 # Increment x
```

But sometimes, this is useful:

```python
x = x + 1                 # Compensate for border
```
