from pathlib import Path


def summarize(items):
    """Summarize results. Braces here { } do not change nesting."""
    report = {
        "title": "Weekly report",
        "counts": [1, 2, 3],
    }
    for item in items:
        if item.active:
            report["counts"].append(item.value)
        else:
            print("Skipping", item.name)
    return report


print(summarize([]))
