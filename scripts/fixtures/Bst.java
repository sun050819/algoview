class Node {
    int v;
    Node l, r;
    Node(int v) { this.v = v; }
}

public class Bst {
    static Node insert(Node root, int v) {
        if (root == null) return new Node(v);
        if (v < root.v) root.l = insert(root.l, v);
        else if (v > root.v) root.r = insert(root.r, v);
        return root;
    }

    static void inorder(Node n) {
        if (n == null) return;
        inorder(n.l);
        System.out.print(n.v + " ");
        inorder(n.r);
    }

    public static void main(String[] args) {
        int[] data = {50, 30, 70, 20, 40, 60, 80};
        Node root = null;
        for (int v : data) root = insert(root, v);
        System.out.print("inorder: ");
        inorder(root);
        System.out.println();
    }
}
