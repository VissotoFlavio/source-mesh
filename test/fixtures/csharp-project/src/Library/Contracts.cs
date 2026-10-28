namespace Synthetic.Library
{
    public interface IProcessor
    {
        int Process(int value);
    }

    public class BaseProcessor
    {
        public int Format(int value)
        {
            return value;
        }
    }
}
