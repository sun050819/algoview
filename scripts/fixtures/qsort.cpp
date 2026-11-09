#include <iostream>
#include <vector>
using namespace std;

void quickSort(vector<int>& a, int lo, int hi) {
    if (lo >= hi) return;
    int pivot = a[hi];
    int i = lo;
    for (int j = lo; j < hi; j++) {
        if (a[j] < pivot) {
            swap(a[i], a[j]);
            i++;
        }
    }
    swap(a[i], a[hi]);
    quickSort(a, lo, i - 1);
    quickSort(a, i + 1, hi);
}

int main() {
    vector<int> a = {7, 2, 9, 4, 1, 8, 3};
    quickSort(a, 0, a.size() - 1);
    cout << "sorted:";
    for (int x : a) cout << " " << x;
    cout << endl;
    return 0;
}
