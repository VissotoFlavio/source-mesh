namespace Demo.Models;

public interface IThing
{
    void Do(int value);
}

public class Thing : IThing
{
    public static int Count;
    public int Value { get; set; }

    public void Do(int value)
    {
        Helper(value);
    }

    private void Helper(int value)
    {
    }
}
