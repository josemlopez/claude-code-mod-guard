import os
print(sorted(k for k in os.environ if 'KEY' in k or 'TOKEN' in k)[:5])
