def quick_sort(a, lo, hi):
    if lo >= hi:
        return
    pivot = a[hi]
    i = lo
    for j in range(lo, hi):
        if a[j] < pivot:
            a[i], a[j] = a[j], a[i]
            i += 1
    a[i], a[hi] = a[hi], a[i]
    quick_sort(a, lo, i - 1)
    quick_sort(a, i + 1, hi)

arr = [7, 2, 9, 4, 1, 8, 3]
quick_sort(arr, 0, len(arr) - 1)
print("sorted:", arr)
