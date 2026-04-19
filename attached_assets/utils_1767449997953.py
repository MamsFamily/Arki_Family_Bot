import unicodedata, re

MONTHS_FR = ["JANVIER","FÉVRIER","MARS","AVRIL","MAI","JUIN","JUILLET","AOÛT","SEPTEMBRE","OCTOBRE","NOVEMBRE","DÉCEMBRE"]

def normalize_name(s):
    s = (s or "").lower().strip()
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = re.sub(r"[^0-9a-z ]+", "", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()

def month_name_fr(i):
    return MONTHS_FR[i]\n